import { Types, VolumeViewport3D } from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';
import { mat4, vec3 } from 'gl-matrix';

const SURFACE_REP = csToolsEnums.SegmentationRepresentations.Surface;

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
 * Applies the same incremental "Shift" to Surface segmentation mesh actors so they
 * move together with the volume-rendered anatomy (approximation along the view axis).
 */
export function shiftSurfaceSegmentationActors(
  viewport: VolumeViewport3D,
  shift: number,
  referenceVolumeActor: Types.Actor
): void {
  if (!shift) {
    return;
  }

  const ofun = referenceVolumeActor.getProperty().getScalarOpacity(0);
  const range = ofun?.getRange?.() ?? [0, 1];
  const transferFunctionWidth = range[1] - range[0] || 1;

  const mapper = referenceVolumeActor.getMapper();
  const imageData = mapper?.getInputData?.();
  let distance = shift;

  if (imageData?.getBounds) {
    const bounds = imageData.getBounds();
    const diagonal = Math.hypot(
      bounds[1] - bounds[0],
      bounds[3] - bounds[2],
      bounds[5] - bounds[4]
    );
    distance = (shift / transferFunctionWidth) * diagonal * 1.5;
  }

  const camera = viewport.getVtkActiveCamera();
  const dop = camera.getDirectionOfProjection();
  const direction = vec3.normalize(
    vec3.create(),
    vec3.fromValues(-dop[0], -dop[1], -dop[2])
  );
  const translation = vec3.scale(vec3.create(), direction, distance);
  const translationMatrix = mat4.fromTranslation(mat4.create(), translation);

  viewport.getActors().forEach(({ actor, representationUID }) => {
    if (typeof representationUID !== 'string' || !representationUID.includes(SURFACE_REP)) {
      return;
    }

    const currentMatrix = actor.getUserMatrix?.();
    const baseMatrix = currentMatrix
      ? (mat4.clone(new Float32Array(currentMatrix)) as mat4)
      : mat4.create();
    const updatedMatrix = mat4.multiply(mat4.create(), translationMatrix, baseMatrix);

    actor.setUserMatrix?.(updatedMatrix);
  });
}

/**
 * Shift volume rendering opacity and linked surface segmentations for a 3D viewport.
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
    shiftScalarOpacityPoints(actor, shift, 1);
  }

  if (viewport instanceof VolumeViewport3D) {
    shiftSurfaceSegmentationActors(viewport, shift, actor);
  }

  viewport.render();
}

/**
 * Resets surface mesh transforms after volume preset / property reset.
 */
export function resetSurfaceSegmentationActorTransforms(viewport: Types.IVolumeViewport): void {
  viewport.getActors().forEach(({ actor, representationUID }) => {
    if (typeof representationUID !== 'string' || !representationUID.includes(SURFACE_REP)) {
      return;
    }

    actor.setUserMatrix?.(mat4.create());
  });
}
