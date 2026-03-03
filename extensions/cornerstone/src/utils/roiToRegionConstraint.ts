/**
 * Utility to extract region constraint from selected ROI annotations for Magic Wand.
 * Converts ROI (Ellipse, Rectangle, Circle, Freehand, Spline, Livewire) to polygon format
 * that the server can use to limit region growing.
 */

import * as csTools from '@cornerstonejs/tools';
import { utilities as csUtils } from '@cornerstonejs/core';
import { StackViewport } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/tools';
import getSOPInstanceAttributes from './measurementServiceMappings/utils/getSOPInstanceAttributes';

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

    return { sliceIndex: imageIndex, polygon };
  }

  // Volume viewport
  const imageData = viewportInfo?.viewportData?.data?.[0]?.volume?.imageData;
  if (!imageData?.worldToIndex) return null;

  const { worldToIndex } = imageData;
  const polygon: number[][] = [];
  let sliceIndex: number | null = null;

  for (const wp of worldPoints) {
    const ijk = worldToIndex(wp);
    if (ijk.length >= 3) {
      const x = Math.round(ijk[0]);
      const y = Math.round(ijk[1]);
      const z = Math.round(ijk[2]);
      polygon.push([x, y]);
      if (sliceIndex === null) sliceIndex = z;
    }
  }

  if (polygon.length < 3 || sliceIndex === null) return null;
  return { sliceIndex, polygon };
}

/**
 * Get region constraint from selected ROI annotations for the given viewport and series.
 * Returns null if no ROI is selected or conversion fails.
 */
export function getRegionConstraintFromSelectedROI(
  viewportId: string,
  seriesInstanceUID: string,
  services: Services
): RegionConstraint | null {
  const { cornerstoneViewportService, displaySetService } = services;
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

  if (!viewport || !viewportInfo) return null;

  const allPolygons: RegionPolygon[] = [];

  for (const toolName of ROI_TOOL_NAMES) {
    const annotationUIDs = csTools.annotation.selection.getAnnotationsSelectedByToolName(toolName);
    if (!annotationUIDs?.length) continue;

    const annotationManager = csTools.annotation.state.getAnnotationManager();
    if (!annotationManager) continue;

    for (const uid of annotationUIDs) {
      const annotation = csTools.annotation.state.getAnnotation(uid);
      if (!annotation) continue;

      const { metadata } = annotation;
      let refSeriesUID: string | undefined;

      if (metadata?.referencedImageId) {
        const attrs = getSOPInstanceAttributes(
          metadata.referencedImageId,
          displaySetService as any,
          annotation
        );
        refSeriesUID = attrs?.SeriesInstanceUID;
      } else {
        const displaySets = displaySetService.getDisplaySetsForSeries(seriesInstanceUID);
        const ds = displaySets?.[0];
        refSeriesUID = ds?.metadata?.SeriesInstanceUID ?? seriesInstanceUID;
      }

      if (refSeriesUID !== seriesInstanceUID) continue;

      const worldPoints = getWorldPointsFromAnnotation(annotation, toolName);
      if (!worldPoints) continue;

      const regionPolygon = worldPointsToVoxelPolygon(worldPoints, viewport, viewportInfo, annotation);
      if (regionPolygon) {
        allPolygons.push(regionPolygon);
      }
    }
  }

  if (allPolygons.length === 0) return null;
  return { polygons: allPolygons };
}
