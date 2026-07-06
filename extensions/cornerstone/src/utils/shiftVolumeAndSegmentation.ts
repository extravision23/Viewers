import { Types, Enums } from '@cornerstonejs/core';
import { mat4, vec3 } from 'gl-matrix';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkClipClosedSurface from '@kitware/vtk.js/Filters/General/ClipClosedSurface';
import type { VolumeCutMode } from '../types/ViewportPresets';

type CutPlaneConfig = { mode: VolumeCutMode; offset: number };

/**
 * Per-actor state for "solid" cutting of segment surface meshes. Surface meshes
 * are hollow shells (flying-edges isosurfaces), so instead of bare mapper
 * clipping planes we clip the polydata with vtkClipClosedSurface, which caps the
 * cut cross-section and makes the segment look solid.
 */
type SolidCutState = {
  originalPolyData: unknown;
  clippedPolyData?: unknown;
  /** Signature of the planes used for the last clip, to skip redundant recomputes. */
  lastPlanesKey?: string;
};

// vtk.js freezes its publicAPI objects, so the state cannot live on the actor
// itself; keyed weakly by actor to be dropped together with it.
const solidCutStates = new WeakMap<object, SolidCutState>();

/**
 * How segment surfaces are cut in a 3D viewport:
 * - 'hollow': legacy behavior - bare GPU clipping planes, the empty inside of
 *   the mesh shell is visible at the cut. Fastest.
 * - 'hybrid': GPU clipping planes during interaction, capped (solid-looking)
 *   clip computed once interaction pauses. Default.
 * - 'solid': capped clip recomputed synchronously on every change. Always
 *   solid, but slow on large meshes / observer-mode rotation.
 */
export type SegmentCutRenderMode = 'hollow' | 'hybrid' | 'solid';

export function getSegmentCutRenderMode(viewport: Types.IVolumeViewport): SegmentCutRenderMode {
  return viewport.__segmentCutRenderMode ?? 'hybrid';
}

/**
 * Whether segment surfaces should render with backface culling (hides the
 * inner wall of the shell so semi-transparent segments look solid). Applies to
 * both capped modes; 'hollow' keeps the legacy two-sided look.
 */
export function isSegmentBackfaceCullingEnabled(viewport: Types.IVolumeViewport): boolean {
  return getSegmentCutRenderMode(viewport) !== 'hollow';
}

/**
 * Sets the segment cut render mode for a viewport: updates backface culling on
 * all segment surface actors and re-applies any active cut planes in the new
 * mode.
 */
export function setSegmentCutRenderMode(
  viewport: Types.IVolumeViewport,
  mode: SegmentCutRenderMode
): void {
  viewport.__segmentCutRenderMode = mode;
  const culling = mode !== 'hollow';

  viewport.getActors().forEach(({ actor }) => {
    if (!isSurfaceMeshActor(actor)) {
      return;
    }
    const property = (actor as unknown as { getProperty?: () => unknown }).getProperty?.() as
      | { setBackfaceCulling?: (value: boolean) => void }
      | undefined;
    property?.setBackfaceCulling?.(culling);
  });

  renderCutPlanes(viewport, (viewport.__cutPlanesConfig as CutPlaneConfig[]) ?? []);
  viewport.render();
}

/** Surface meshes (segments) are vtkActor; volumes are vtkVolume. */
function isSurfaceMeshActor(actor: Types.Actor): boolean {
  return typeof (actor as unknown as { isA?: (name: string) => boolean }).isA === 'function'
    ? (actor as unknown as { isA: (name: string) => boolean }).isA('vtkActor')
    : false;
}

function buildPlanesKey(vtkPlanes: ReturnType<typeof vtkPlane.newInstance>[]): string {
  return vtkPlanes
    .map(plane => [...plane.getNormal(), ...plane.getOrigin()].map(v => v.toFixed(4)).join(','))
    .join(';');
}

/**
 * Puts the original (unclipped) polydata back on the mapper but keeps the
 * solid-cut cache, so an unchanged capped mesh can be reused without a
 * recompute (e.g. after a camera move with static cut planes).
 */
function showOriginalSurfacePolyData(actor): void {
  const state = solidCutStates.get(actor);
  const mapper = actor.getMapper?.();
  if (!state || !mapper) {
    return;
  }
  if (mapper.getInputData?.() === state.clippedPolyData) {
    mapper.setInputData(state.originalPolyData);
  }
}

/**
 * Restores the original (unclipped) polydata on a surface actor and drops the
 * solid-cut state.
 */
function restoreSurfaceActorPolyData(actor): void {
  showOriginalSurfacePolyData(actor);
  solidCutStates.delete(actor);
}

/**
 * Clips a segment surface actor with vtkClipClosedSurface so the cut is capped
 * (solid-looking) instead of exposing the hollow inside of the mesh shell. The
 * original polydata is cached on the actor and restored when no cut is active.
 */
function applyCappedClipToSurfaceActor(
  actor,
  vtkPlanes: ReturnType<typeof vtkPlane.newInstance>[]
): void {
  const mapper = actor.getMapper?.();
  if (!mapper?.getInputData) {
    return;
  }

  // Mesh actors are clipped by replacing the mapper input, not by mapper
  // clipping planes (those would leave the shell open at the cut).
  mapper.removeAllClippingPlanes?.();

  if (!vtkPlanes.length) {
    restoreSurfaceActorPolyData(actor);
    return;
  }

  let state = solidCutStates.get(actor);
  const currentInput = mapper.getInputData();

  // If the surface data was recomputed by cornerstone since the last clip (the
  // mapper input is neither our cached original nor our clipped output), treat
  // the current input as the new original and drop the stale cache.
  if (
    !state ||
    (currentInput !== state.originalPolyData && currentInput !== state.clippedPolyData)
  ) {
    state = { originalPolyData: currentInput };
    solidCutStates.set(actor, state);
  }

  const planesKey = buildPlanesKey(vtkPlanes);
  if (state.lastPlanesKey === planesKey && state.clippedPolyData) {
    // Same planes as the cached capped mesh: reuse it without recomputing.
    if (currentInput !== state.clippedPolyData) {
      mapper.setInputData(state.clippedPolyData);
    }
    return;
  }

  const clipper = vtkClipClosedSurface.newInstance({
    clippingPlanes: vtkPlanes,
    generateFaces: true,
    generateOutline: false,
  });
  clipper.setInputData(state.originalPolyData);
  const clipped = clipper.getOutputData();

  state.clippedPolyData = clipped;
  state.lastPlanesKey = planesKey;
  mapper.setInputData(clipped);
}

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
 * anatomically registered to the voxels. Use applyVolumeCutPlanes for spatial cuts.
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
    // While a surface actor shows clipped geometry, measure the cached original
    // polydata so plane placement stays stable across successive cuts.
    const originalPolyData = solidCutStates.get(actor)?.originalPolyData as
      | { getBounds?: () => number[] }
      | undefined;
    const bounds = originalPolyData?.getBounds?.() ?? actor.getBounds?.();
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

/** How long interaction must pause before the expensive capped clip runs. */
const CAP_RECOMPUTE_DELAY_MS = 200;

/**
 * Rebuilds the vtkPlane instances for the given cut config (observer planes
 * depend on the current camera). Returns null when actor bounds are unusable.
 */
function computeVtkPlanes(
  viewport: Types.IVolumeViewport,
  planes: CutPlaneConfig[]
): ReturnType<typeof vtkPlane.newInstance>[] | null {
  const bounds = getViewportBounds(viewport);
  if (!bounds) {
    return null;
  }

  return (planes ?? [])
    .map(({ mode, offset }) => buildCutPlane(viewport, bounds, mode, offset))
    .filter((plane): plane is ReturnType<typeof vtkPlane.newInstance> => plane !== null);
}

function cancelScheduledCappedClip(viewport: Types.IVolumeViewport): void {
  if (viewport.__capClipTimer !== undefined) {
    clearTimeout(viewport.__capClipTimer);
    viewport.__capClipTimer = undefined;
  }
}

/**
 * Runs the expensive capped clip (vtkClipClosedSurface) on all segment surface
 * actors using the currently stored cut config. Called only after interaction
 * pauses; during interaction the surfaces use fast GPU clipping planes.
 *
 * Segments are processed one per macrotask (yielding the main thread between
 * them and rendering progressively), so many/large meshes cause several short
 * hitches instead of one long freeze. A new interaction cancels the chain via
 * cancelScheduledCappedClip.
 */
function applyCappedClipToSurfaces(viewport: Types.IVolumeViewport): void {
  const config = (viewport.__cutPlanesConfig as CutPlaneConfig[]) ?? [];
  const vtkPlanes = computeVtkPlanes(viewport, config);
  if (!vtkPlanes) {
    return;
  }

  const surfaceActors = viewport.getActors().filter(({ actor }) => isSurfaceMeshActor(actor));
  if (!surfaceActors.length) {
    return;
  }

  let index = 0;
  const processNext = () => {
    viewport.__capClipTimer = undefined;
    applyCappedClipToSurfaceActor(surfaceActors[index].actor, vtkPlanes);
    index++;
    viewport.render();
    if (index < surfaceActors.length) {
      viewport.__capClipTimer = setTimeout(processNext, 0);
    }
  };
  processNext();
}

/**
 * Debounces the capped clip until the user stops dragging the cut slider /
 * rotating the camera. The CPU mesh clip of every segment is far too slow to
 * run per input event, while GPU clipping planes are free.
 */
function scheduleCappedClip(viewport: Types.IVolumeViewport): void {
  cancelScheduledCappedClip(viewport);
  viewport.__capClipTimer = setTimeout(() => {
    viewport.__capClipTimer = undefined;
    applyCappedClipToSurfaces(viewport);
  }, CAP_RECOMPUTE_DELAY_MS);
}

/**
 * Rebuilds the clipping planes from a config and applies them to every actor
 * mapper. The observer plane is rebuilt from the live camera, so calling this on
 * camera change keeps the "from observer" cut aligned with the current view.
 *
 * Segment surface handling depends on the viewport's SegmentCutRenderMode:
 * - 'hollow': fast GPU clipping planes only.
 * - 'hybrid': GPU planes now, capped clip deferred until interaction pauses.
 * - 'solid': capped clip computed synchronously right here.
 */
function renderCutPlanes(viewport: Types.IVolumeViewport, planes: CutPlaneConfig[]): void {
  const vtkPlanes = computeVtkPlanes(viewport, planes);
  if (!vtkPlanes) {
    return;
  }

  const mode = getSegmentCutRenderMode(viewport);
  const planesKey = buildPlanesKey(vtkPlanes);
  let needsDeferredCappedClip = false;

  viewport.getActors().forEach(({ actor }) => {
    if (isSurfaceMeshActor(actor)) {
      if (mode === 'solid') {
        // Always solid: pay the CPU cost immediately (the per-actor cache still
        // skips recomputes when the planes have not changed).
        applyCappedClipToSurfaceActor(actor, vtkPlanes);
        return;
      }

      if (mode === 'hybrid' && vtkPlanes.length) {
        const state = solidCutStates.get(actor);
        const mapper = actor.getMapper?.();
        if (
          state?.lastPlanesKey === planesKey &&
          mapper?.getInputData?.() === state.clippedPolyData
        ) {
          // The displayed capped mesh already matches these planes (e.g. camera
          // rotation with static cuts) - leave it untouched.
          return;
        }
        needsDeferredCappedClip = true;
      }
      // Show the original (uncapped) geometry during interaction; a stale
      // capped mesh would hide regions the new plane position should reveal.
      // The cache is kept so an unchanged cut can reuse the capped mesh.
      showOriginalSurfacePolyData(actor);
    }

    const mapper = actor.getMapper?.();
    if (!mapper?.removeAllClippingPlanes) {
      return;
    }
    mapper.removeAllClippingPlanes();
    vtkPlanes.forEach(plane => mapper.addClippingPlane?.(plane));
  });

  viewport.render();

  if (needsDeferredCappedClip) {
    scheduleCappedClip(viewport);
  } else {
    cancelScheduledCappedClip(viewport);
  }
}

/**
 * Detaches the camera-tracking listener if present and cancels any pending
 * throttled recompute.
 */
function detachCutCameraTracking(viewport: Types.IVolumeViewport): void {
  const handler = viewport.__cutCameraHandler;
  if (handler) {
    viewport.element?.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler);
  }
  viewport.__cutCameraHandler = undefined;
  if (viewport.__cutRafId !== undefined) {
    cancelAnimationFrame(viewport.__cutRafId);
    viewport.__cutRafId = undefined;
  }
}

/**
 * Attaches a camera-tracking listener that re-applies the stored cut planes on
 * every camera change. This keeps the observer cut following the viewer and
 * ensures all clipping planes survive camera rotation.
 */
function attachCutCameraTracking(viewport: Types.IVolumeViewport): void {
  if (viewport.__cutCameraHandler) {
    return;
  }
  // Throttle to one recompute per animation frame: the observer-mode capped
  // clip (vtkClipClosedSurface) runs on the CPU, and camera-modified events can
  // fire much more often than the display refreshes.
  const handler = () => {
    if (viewport.__cutRafId !== undefined) {
      return;
    }
    viewport.__cutRafId = requestAnimationFrame(() => {
      viewport.__cutRafId = undefined;
      const stored = viewport.__cutPlanesConfig as CutPlaneConfig[] | undefined;
      if (stored?.length) {
        renderCutPlanes(viewport, stored);
      }
    });
  };
  viewport.__cutCameraHandler = handler;
  viewport.element?.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
}

/**
 * Removes any clipping planes from every actor mapper of the viewport and stops
 * camera tracking.
 */
export function clearVolumeCutPlanes(viewport: Types.IVolumeViewport): void {
  detachCutCameraTracking(viewport);
  cancelScheduledCappedClip(viewport);
  viewport.__cutPlanesConfig = undefined;
  viewport.getActors().forEach(({ actor }) => {
    if (isSurfaceMeshActor(actor)) {
      restoreSurfaceActorPolyData(actor);
    }
    const mapper = actor.getMapper?.();
    mapper?.removeAllClippingPlanes?.();
  });
  viewport.render();
}

/**
 * Builds a single clipping plane for the given cut mode/offset, or null when the
 * offset is 0 (no cut). The plane normal points into the region that stays
 * visible; the offset sign chooses which side is removed and the magnitude
 * controls how deep the cut goes.
 */
function buildCutPlane(
  viewport: Types.IVolumeViewport,
  bounds: { min: vec3; max: vec3 },
  mode: VolumeCutMode,
  offset: number
): ReturnType<typeof vtkPlane.newInstance> | null {
  if (!offset) {
    return null;
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

  return plane;
}

/**
 * Applies a combination of clipping planes to ALL actors of the viewport (volume
 * render, merged labelmap and segment surfaces) so the cuts affect both the
 * volume label and the segment identically. Multiple planes intersect, so e.g. a
 * sagittal and a coronal cut together carve out a corner of the volume.
 *
 * @param planes - the active cut planes; entries with offset 0 are ignored.
 */
export function applyVolumeCutPlanes(
  viewport: Types.IVolumeViewport,
  planes: CutPlaneConfig[]
): void {
  const config = planes ?? [];
  viewport.__cutPlanesConfig = config;

  renderCutPlanes(viewport, config);

  // Re-apply the clipping planes on every camera change while any cut is active.
  // This keeps the observer cut aligned with the view AND works around the volume
  // mapper dropping/!updating its clipping planes on rotation, which otherwise
  // makes the volume nearly vanish once the camera moves.
  const anyActive = config.some(({ offset }) => offset);
  if (anyActive) {
    attachCutCameraTracking(viewport);
  } else {
    detachCutCameraTracking(viewport);
  }
}
