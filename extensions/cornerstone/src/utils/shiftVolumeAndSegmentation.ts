import { Types } from '@cornerstonejs/core';
import { mat4, vec3 } from 'gl-matrix';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import type { VolumeCutMode } from '../types/ViewportPresets';

/**
 * Shifts scalar opacity transfer-function nodes (volume rendering "Shift" control).
 */
export function shiftScalarOpacityPoints(
  actor: Types.Actor,
  shift: number,
  componentIndex = 0
): void {
  const property = actor.getProperty();
  const ofun = property.getScalarOpacity(componentIndex);

  if (!ofun?.getSize) {
    return;
  }

  const size = ofun.getSize();
  if (!size) {
    return;
  }

  const opacityPointValues: number[][] = [];

  for (let pointIdx = 0; pointIdx < size; pointIdx++) {
    const opacityPointValue = [0, 0, 0, 0];
    ofun.getNodeValue(pointIdx, opacityPointValue);
    opacityPointValues.push(opacityPointValue);
  }

  opacityPointValues.forEach(opacityPointValue => {
    opacityPointValue[0] += shift;
  });

  ofun.removeAllPoints();
  opacityPointValues.forEach(opacityPointValue => {
    ofun.addPoint(...opacityPointValue);
  });
}

/**
 * Shift volume rendering opacity transfer function for a 3D viewport.
 *
 * This is a transfer-function-only operation (reveals/peels tissue); it does NOT
 * move anything spatially, so segmentation actors must stay in place to remain
 * anatomically registered to the voxels. Use applyVolumeCutPlane for spatial cuts.
 */
export function shiftVolumeOpacityPointsWithSegmentation(
  viewport: Types.IVolumeViewport,
  shift: number
): void {
  const defaultActorEntry = viewport.getDefaultActor?.() ?? viewport.getActors()[0];

  if (!defaultActorEntry?.actor) {
    return;
  }

  const { actor } = defaultActorEntry;

  shiftScalarOpacityPoints(actor, shift, 0);

  const property = actor.getProperty();
  if (property.getIndependentComponents?.()) {
    // Merged labelmap component shares the volume actor; shift it too.
    shiftScalarOpacityPoints(actor, shift, 1);
  }

  viewport.render();
}

/**
 * Resets spatial transforms (userMatrix) on ALL viewport actors after a volume
 * preset / property reset, keeping volume and segmentation aligned at identity.
 */
export function resetViewportActorTransforms(viewport: Types.IVolumeViewport): void {
  const identity = mat4.create();

  viewport.getActors().forEach(({ actor }) => {
    actor.setUserMatrix?.(identity);
  });
}

/**
 * Computes the combined world-space bounds of all viewport actors.
 * Returns null when no actor reports usable bounds.
 */
function getViewportBounds(
  viewport: Types.IVolumeViewport
): { min: vec3; max: vec3 } | null {
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);

  viewport.getActors().forEach(({ actor }) => {
    const bounds = actor.getBounds?.();
    if (!bounds) {
      return;
    }
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], bounds[axis * 2]);
      max[axis] = Math.max(max[axis], bounds[axis * 2 + 1]);
    }
  });

  if (!Number.isFinite(min[0])) {
    return null;
  }

  return { min, max };
}

/**
 * Half-extent of an axis-aligned bounding box measured along an arbitrary
 * (unit) normal, i.e. half the projected width of the box onto that normal.
 */
function getHalfExtentAlongNormal(min: vec3, max: vec3, normal: vec3): number {
  return (
    0.5 *
    (Math.abs((max[0] - min[0]) * normal[0]) +
      Math.abs((max[1] - min[1]) * normal[1]) +
      Math.abs((max[2] - min[2]) * normal[2]))
  );
}

/**
 * Returns the world-space base normal for a given cut mode. The convention is
 * that a positive offset removes the slab on the +baseNormal side of the volume.
 *
 * - observer: towards the camera (-direction of projection), so positive offset
 *   cuts away the tissue nearest the viewer, matching the legacy "Move" feel.
 * - sagittal: world X (left/right), coronal: world Y (anterior/posterior),
 *   axial: world Z (superior/inferior).
 */
function getCutBaseNormal(viewport: Types.IVolumeViewport, mode: VolumeCutMode): vec3 {
  switch (mode) {
    case 'sagittal':
      return vec3.fromValues(1, 0, 0);
    case 'coronal':
      return vec3.fromValues(0, 1, 0);
    case 'axial':
      return vec3.fromValues(0, 0, 1);
    case 'observer':
    default: {
      const camera = viewport.getVtkActiveCamera();
      const dop = camera.getDirectionOfProjection();
      return vec3.normalize(vec3.create(), vec3.fromValues(-dop[0], -dop[1], -dop[2]));
    }
  }
}

/**
 * Removes any clipping planes from every actor mapper of the viewport.
 */
export function clearVolumeCutPlanes(viewport: Types.IVolumeViewport): void {
  viewport.getActors().forEach(({ actor }) => {
    const mapper = actor.getMapper?.();
    mapper?.removeAllClippingPlanes?.();
  });
  viewport.render();
}

/**
 * Applies a single clipping plane to ALL actors of the viewport (volume render,
 * merged labelmap and segment surfaces) so the cut affects both the volume label
 * and the segment identically.
 *
 * @param mode - cut plane orientation (observer / coronal / sagittal / axial).
 * @param offset - signed distance from the volume center (mm). A value of 0
 *   removes the cut entirely; the sign chooses which side is removed and the
 *   magnitude controls how deep the cut goes.
 */
export function applyVolumeCutPlane(
  viewport: Types.IVolumeViewport,
  mode: VolumeCutMode,
  offset: number
): void {
  if (!offset) {
    clearVolumeCutPlanes(viewport);
    return;
  }

  const bounds = getViewportBounds(viewport);
  if (!bounds) {
    return;
  }
  const { min, max } = bounds;
  const center = vec3.fromValues(
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  );

  const baseNormal = getCutBaseNormal(viewport, mode);
  const halfExtent = getHalfExtentAlongNormal(min, max, baseNormal);

  const side = Math.sign(offset);
  // Clamp the cut depth so it never overshoots the volume extent.
  const depth = Math.min(Math.abs(offset), 2 * halfExtent);

  // Plane sits "depth" away from the +/- side edge; the normal points into the
  // region that stays visible (opposite to the side being cut away).
  const clipNormal = vec3.scale(vec3.create(), baseNormal, -side);
  const origin = vec3.scaleAndAdd(vec3.create(), center, baseNormal, side * (halfExtent - depth));

  const plane = vtkPlane.newInstance();
  plane.setNormal(clipNormal[0], clipNormal[1], clipNormal[2]);
  plane.setOrigin(origin[0], origin[1], origin[2]);

  viewport.getActors().forEach(({ actor }) => {
    const mapper = actor.getMapper?.();
    if (!mapper?.addClippingPlane) {
      return;
    }
    mapper.removeAllClippingPlanes?.();
    mapper.addClippingPlane(plane);
  });

  viewport.render();
}
