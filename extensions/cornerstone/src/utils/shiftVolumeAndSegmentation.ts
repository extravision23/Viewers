import { Types } from '@cornerstonejs/core';
import { mat4, vec3 } from 'gl-matrix';

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
 * anatomically registered to the voxels. Use moveViewportActors for spatial moves.
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
 * Spatially translates ALL actors of the viewport (volume render + surface
 * segmentations) by the same world-space delta along the current camera view
 * direction. Because the identical translation matrix is applied to every actor,
 * the volume and its segmentation can never drift apart.
 *
 * The merged labelmap rides on the volume actor, so it moves automatically.
 *
 * @param moveDelta - incremental distance in world units (mm); positive moves
 *   towards the camera.
 */
export function moveViewportActors(viewport: Types.IVolumeViewport, moveDelta: number): void {
  if (!moveDelta) {
    return;
  }

  const camera = viewport.getVtkActiveCamera();
  const dop = camera.getDirectionOfProjection();
  const direction = vec3.normalize(
    vec3.create(),
    vec3.fromValues(-dop[0], -dop[1], -dop[2])
  );
  const translation = vec3.scale(vec3.create(), direction, moveDelta);
  const translationMatrix = mat4.fromTranslation(mat4.create(), translation);

  viewport.getActors().forEach(({ actor }) => {
    if (!actor.setUserMatrix) {
      return;
    }

    const currentMatrix = actor.getUserMatrix?.();
    const baseMatrix = currentMatrix
      ? (mat4.clone(new Float32Array(currentMatrix)) as mat4)
      : mat4.create();
    const updatedMatrix = mat4.multiply(mat4.create(), translationMatrix, baseMatrix);

    actor.setUserMatrix(updatedMatrix);
  });

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
