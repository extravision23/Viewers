/**
 * Utility to extract region constraint from selected ROI annotations for Magic Wand.
 * Converts ROI (Ellipse, Rectangle, Circle, Freehand, Spline, Livewire) to polygon format
 * that the server can use to limit region growing.
 */

import * as csTools from '@cornerstonejs/tools';
import { utilities as csUtils } from '@cornerstonejs/core';
import { StackViewport } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/tools';

const ROI_TOOL_NAMES = [
  'EllipticalROI',
  'RectangleROI',
  'CircleROI',
  'PlanarFreehandROI',
  'SplineROI',
  'LivewireContour',
] as const;

export interface RegionPolygon {
  sliceIndex: number;
  polygon: number[][]; // [[x, y], [x, y], ...] in voxel coords (x=col, y=row)
  plane?: 'axial' | 'sagittal' | 'coronal';
}

export interface RegionConstraint {
  polygons: RegionPolygon[];
}

type Services = {
  cornerstoneViewportService: { getCornerstoneViewport: (id: string) => unknown; getViewportInfo: (id: string) => unknown };
  displaySetService: { getDisplaySetsForSeries: (uid: string) => { metadata?: { SeriesInstanceUID?: string } }[] };
};

/**
 * Sample ellipse with N points (parametric form).
 */
function ellipseToPolygon(
  center: [number, number, number],
  point1: [number, number, number],
  point2: [number, number, number],
  numPoints = 64
): [number, number, number][] {
  const [cx, cy, cz] = center;
  const dx1 = point1[0] - cx;
  const dy1 = point1[1] - cy;
  const dx2 = point2[0] - cx;
  const dy2 = point2[1] - cy;
  const a = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const b = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  const angle = Math.atan2(dy1, dx1);
  const points: [number, number, number][] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = (2 * Math.PI * i) / numPoints;
    const px = cx + a * Math.cos(t) * Math.cos(angle) - b * Math.sin(t) * Math.sin(angle);
    const py = cy + a * Math.cos(t) * Math.sin(angle) + b * Math.sin(t) * Math.cos(angle);
    points.push([px, py, cz]);
  }
  return points;
}

/**
 * Circle to polygon (center + point on circumference).
 */
function circleToPolygon(
  center: [number, number, number],
  pointOnCircle: [number, number, number],
  numPoints = 64
): [number, number, number][] {
  const [cx, cy, cz] = center;
  const dx = pointOnCircle[0] - cx;
  const dy = pointOnCircle[1] - cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const points: [number, number, number][] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = (2 * Math.PI * i) / numPoints;
    points.push([cx + r * Math.cos(t), cy + r * Math.sin(t), cz]);
  }
  return points;
}

/**
 * Extract polygon points from annotation based on tool type.
 */
function getWorldPointsFromAnnotation(
  annotation: Types.Annotation,
  toolName: string
): [number, number, number][] | null {
  const { data } = annotation;
  if (!data) return null;

  if (toolName === 'PlanarFreehandROI' || toolName === 'SplineROI' || toolName === 'LivewireContour') {
    const polyline = (data as any).contour?.polyline;
    if (polyline && Array.isArray(polyline) && polyline.length > 0) {
      return polyline.map((p: number[]) =>
        p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1], 0]
      ) as [number, number, number][];
    }
  }

  const points = (data as any).handles?.points;
  if (!points || !Array.isArray(points)) return null;

  if (toolName === 'RectangleROI') {
    return points.map((p: number[]) =>
      p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1], 0]
    ) as [number, number, number][];
  }

  if (toolName === 'EllipticalROI' && points.length >= 4) {
    return ellipseToPolygon(
      points[0] as [number, number, number],
      points[1] as [number, number, number],
      points[2] as [number, number, number]
    );
  }

  if (toolName === 'CircleROI' && points.length >= 2) {
    return circleToPolygon(
      points[0] as [number, number, number],
      points[1] as [number, number, number]
    );
  }

  return points.map((p: number[]) =>
    p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1], 0]
  ) as [number, number, number][];
}

/**
 * Convert world points to voxel polygon for a given viewport.
 * For stack: uses annotation's referencedImageId to get correct slice.
 */
function worldPointsToVoxelPolygon(
  worldPoints: [number, number, number][],
  viewport: any,
  viewportInfo: any,
  plane?: 'axial' | 'sagittal' | 'coronal',
  annotation?: Types.Annotation
): RegionPolygon | null {
  if (worldPoints.length < 3) return null;

  const isStackViewport = viewport?.constructor?.name === 'StackViewport' || viewport instanceof StackViewport;

  if (isStackViewport) {
    const imageId = annotation?.metadata?.referencedImageId ?? viewport.getCurrentImageId?.();
    if (!imageId) return null;

    const imageIds = viewport.getImageIds?.() ?? [];
    const imageIndex = imageIds.indexOf(imageId);
    if (imageIndex < 0) return null;

    const polygon: number[][] = [];
    for (const wp of worldPoints) {
      const imagePoint = csUtils.worldToImageCoords(imageId, wp);
      polygon.push([Math.round(imagePoint[0]), Math.round(imagePoint[1])]);
    }

    return { sliceIndex: imageIndex, polygon, plane };
  }

  // Volume viewport: we infer 2D slice plane from voxel points in the reference volume.
  const imageData = viewportInfo?.viewportData?.data?.[0]?.volume?.imageData;
  if (!imageData?.worldToIndex) return null;

  const { worldToIndex } = imageData;
  const ijkPoints: Array<[number, number, number]> = [];

  for (const wp of worldPoints) {
    const ijk = worldToIndex(wp);
    if (ijk.length >= 3) {
      ijkPoints.push([Math.round(ijk[0]), Math.round(ijk[1]), Math.round(ijk[2])]);
    }
  }

  if (ijkPoints.length < 3) return null;

  const xs = ijkPoints.map(p => p[0]);
  const ys = ijkPoints.map(p => p[1]);
  const zs = ijkPoints.map(p => p[2]);

  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const zRange = Math.max(...zs) - Math.min(...zs);

  // Infer which anatomical plane ROI was drawn in by finding the most-constant axis.
  // - axial: z constant
  // - sagittal: x constant
  // - coronal: y constant
  let inferredPlane: 'axial' | 'sagittal' | 'coronal';
  let sliceIndex: number;

  if (zRange <= xRange && zRange <= yRange) {
    inferredPlane = 'axial';
    sliceIndex = Math.round(zs.reduce((a, b) => a + b, 0) / zs.length);
  } else if (xRange <= yRange && xRange <= zRange) {
    inferredPlane = 'sagittal';
    sliceIndex = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  } else {
    inferredPlane = 'coronal';
    sliceIndex = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
  }

  // Build 2D polygon coords in the inferred plane.
  // Backend expects:
  // - axial:    polygon=[x,y]
  // - sagittal:polygon=[y,z]
  // - coronal: polygon=[x,z]
  const polygon: number[][] = ijkPoints.map(([x, y, z]) => {
    if (inferredPlane === 'sagittal') return [y, z];
    if (inferredPlane === 'coronal') return [x, z];
    return [x, y];
  });

  if (polygon.length < 3) return null;
  return { sliceIndex, polygon, plane: inferredPlane };
}

/**
 * Get region constraint from selected ROI annotations for the given viewport and series.
 * Returns null if no ROI is selected or conversion fails.
 */
export function getRegionConstraintFromSelectedROI(
  viewportId: string,
  _seriesInstanceUID: string,
  services: Services
): RegionConstraint | null {
  const { cornerstoneViewportService, displaySetService } = services;
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

  if (!viewport || !viewportInfo) return null;

  // NOTE: for volume viewports we infer plane per-ROI in voxel space,
  // so we don't need to pass a plane derived from viewport orientation.

  const allPolygons: RegionPolygon[] = [];

  for (const toolName of ROI_TOOL_NAMES) {
    const annotationManager = csTools.annotation.state.getAnnotationManager();
    if (!annotationManager) continue;

    // Include all ROI annotations for this tool type across frames of reference.
    // (annotationManager.getAnnotations(toolName) isn't a supported API, so we iterate frames.)
    const framesOfReference: string[] = annotationManager.getFramesOfReference?.() ?? [];

    let annotationsForTool: Types.Annotation[] = [];
    for (const frameOfReferenceUID of framesOfReference) {
      const frameAnnotations = annotationManager.getAnnotations(frameOfReferenceUID as any) as
        | Record<string, Types.Annotation[]>
        | undefined;
      const toolAnnotations = frameAnnotations?.[toolName as any];
      if (toolAnnotations?.length) {
        annotationsForTool = annotationsForTool.concat(toolAnnotations);
      }
    }

    if (!annotationsForTool.length) continue;

    for (const annotation of annotationsForTool) {
      const worldPoints = getWorldPointsFromAnnotation(annotation, toolName);
      if (!worldPoints) continue;

      const regionPolygon = worldPointsToVoxelPolygon(
        worldPoints,
        viewport,
        viewportInfo,
        undefined,
        annotation
      );
      if (regionPolygon) {
        allPolygons.push(regionPolygon);
      }
    }
  }

  if (allPolygons.length === 0) return null;
  return { polygons: allPolygons };
}
