import {
  cache,
  Enums,
  eventTarget,
  volumeLoader,
  utilities as csUtils,
  Types,
} from '@cornerstonejs/core';
import { Enums as csToolsEnums, segmentation as cstSegmentation } from '@cornerstonejs/tools';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

export type VolumetricSegmentLighting = {
  shade?: boolean;
  ambient?: number;
  diffuse?: number;
  specular?: number;
  specularPower?: number;
};

/** Default lighting when the anatomy volume has not been configured yet. */
const DEFAULT_VOLUMETRIC_LIGHTING: Required<VolumetricSegmentLighting> = {
  shade: true,
  ambient: 0.2,
  diffuse: 0.75,
  specular: 0.15,
  specularPower: 20,
};

/**
 * Phong lighting on a volumetric labelmap actor. Gradients exist at segment
 * boundaries and outer surfaces, so shading adds depth without hollowing the
 * fill (unlike gradient-opacity, which would emphasize edges only).
 */
export function applyVolumetricSegmentLighting(
  property: {
    setShade?: (v: boolean) => void;
    setAmbient?: (v: number) => void;
    setDiffuse?: (v: number) => void;
    setSpecular?: (v: number) => void;
    setSpecularPower?: (v: number) => void;
  },
  options: VolumetricSegmentLighting = DEFAULT_VOLUMETRIC_LIGHTING
): void {
  const merged = { ...DEFAULT_VOLUMETRIC_LIGHTING, ...options };
  property.setShade?.(merged.shade);
  property.setAmbient?.(merged.ambient);
  property.setDiffuse?.(merged.diffuse);
  property.setSpecular?.(merged.specular);
  property.setSpecularPower?.(merged.specularPower);
}

/** Reads shade/ambient/diffuse/specular from the anatomy (default) volume actor. */
export function getAnatomyVolumeLighting(
  viewport: Types.IVolumeViewport
): VolumetricSegmentLighting {
  const defaultEntry = viewport.getDefaultActor?.() ?? viewport.getActors()[0];
  const property = defaultEntry?.actor?.getProperty?.() as
    | {
        getShade?: () => boolean;
        getAmbient?: () => number;
        getDiffuse?: () => number;
        getSpecular?: () => number;
        getSpecularPower?: () => number;
      }
    | undefined;
  if (!property) {
    return DEFAULT_VOLUMETRIC_LIGHTING;
  }
  return {
    shade: property.getShade?.() ?? DEFAULT_VOLUMETRIC_LIGHTING.shade,
    ambient: property.getAmbient?.() ?? DEFAULT_VOLUMETRIC_LIGHTING.ambient,
    diffuse: property.getDiffuse?.() ?? DEFAULT_VOLUMETRIC_LIGHTING.diffuse,
    specular: property.getSpecular?.() ?? DEFAULT_VOLUMETRIC_LIGHTING.specular,
    specularPower: property.getSpecularPower?.() ?? DEFAULT_VOLUMETRIC_LIGHTING.specularPower,
  };
}

/**
 * Applies lighting options to every volumetric segment labelmap actor on the
 * viewport (used when the user adjusts Shade / Lighting on the presets panel).
 */
export function applyLightingToVolumetricSegmentActors(
  viewport: Types.IVolumeViewport,
  options: VolumetricSegmentLighting
): void {
  const state = volumetricStates.get(viewport.id);
  if (!state?.entries.length) {
    return;
  }
  state.entries.forEach(({ actorUID }) => {
    const actorEntry = getVolumetricActorEntry(viewport, actorUID);
    if (actorEntry?.actor?.getProperty) {
      applyVolumetricSegmentLighting(actorEntry.actor.getProperty(), options);
    }
  });
}

/**
 * Volumetric display of segmentations on a 3D viewport: the labelmap volume is
 * ray-cast by the GPU as a separate vtkVolume actor, with per-segment-index
 * color/opacity transfer functions. Unlike surface meshes, the labelmap is
 * filled by nature, so clipping planes cut it "solid" with zero CPU cost.
 *
 * This exists because Cornerstone Tools' labelmapDisplay gates its volume path
 * on `instanceof VolumeViewport` (MPR) and silently skips VolumeViewport3D, so
 * we add and maintain the actor ourselves.
 */

type VolumetricEntry = {
  segmentationId: string;
  volumeId: string;
  actorUID: string;
};

type VolumetricState = {
  entries: VolumetricEntry[];
  cleanup: () => void;
};

const volumetricStates = new Map<string, VolumetricState>();

// VolumeIds ever added by this module, kept after disable: the viewport's
// internal volumeId list is append-only, so consumers iterating
// getAllVolumeIds (e.g. the hideVolume listeners) must skip these forever.
const volumetricVolumeIds = new Map<string, Set<string>>();

/**
 * True when the volumeId on this viewport belongs to a volumetric segment
 * actor (as opposed to the anatomy volume). Used to exclude segment labelmaps
 * from "hide anatomy volume" logic.
 */
export function isVolumetricSegmentVolumeId(viewportId: string, volumeId: string): boolean {
  return volumetricVolumeIds.get(viewportId)?.has(volumeId) ?? false;
}

function getViewportSegmentationIds(viewportId: string): string[] {
  const representations = cstSegmentation.state.getSegmentationRepresentations(viewportId) ?? [];
  return [...new Set(representations.map(rep => rep.segmentationId))];
}

/**
 * Resolves (and creates if needed) the cached labelmap volume for a
 * segmentation. Returns null when the segmentation has no labelmap data.
 */
async function ensureLabelmapVolume(segmentationId: string): Promise<string | null> {
  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
  const labelmapData = segmentation?.representationData?.[LABELMAP] as
    | { volumeId?: string; imageIds?: string[] }
    | undefined;
  if (!labelmapData) {
    return null;
  }

  let { volumeId } = labelmapData;
  if (!volumeId) {
    if (!labelmapData.imageIds?.length) {
      return null;
    }
    volumeId = csUtils.uuidv4();
    labelmapData.volumeId = volumeId;
  }

  if (!cache.getVolume(volumeId)) {
    if (!labelmapData.imageIds?.length) {
      return null;
    }
    await volumeLoader.createAndCacheVolumeFromImages(volumeId, labelmapData.imageIds);
  }

  return volumeId;
}

/**
 * Builds and applies per-segment-index transfer functions on the labelmap
 * volume actor (mirrors Cornerstone's _setLabelmapColorAndOpacity, which never
 * runs for 3D viewports). Index 0 (background) is fully transparent; hidden
 * segments get opacity 0.
 */
function applyLabelmapTransferFunctions(
  viewport: Types.IVolumeViewport,
  segmentationId: string,
  actor
): void {
  const viewportId = viewport.id;
  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
  if (!segmentation) {
    return;
  }

  const segmentIndices = Object.keys(segmentation.segments ?? {})
    .map(Number)
    .filter(index => index > 0);

  const hiddenSegments = cstSegmentation.config.visibility.getHiddenSegmentIndices(viewportId, {
    segmentationId,
    type: LABELMAP,
  });

  const style = cstSegmentation.config.style.getStyle({
    viewportId,
    segmentationId,
    type: LABELMAP,
  }) as { fillAlpha?: number } | undefined;
  const fillAlpha = style?.fillAlpha ?? 1;

  const cfun = vtkColorTransferFunction.newInstance();
  const ofun = vtkPiecewiseFunction.newInstance();
  cfun.addRGBPoint(0, 0, 0, 0);
  ofun.addPointLong(0, 0, 0.5, 1.0);

  segmentIndices.forEach(segmentIndex => {
    const color = cstSegmentation.config.color.getSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex
    );
    if (!color) {
      return;
    }
    cfun.addRGBPoint(segmentIndex, color[0] / 255, color[1] / 255, color[2] / 255);
    const opacity = hiddenSegments.has(segmentIndex) ? 0 : (color[3] / 255) * fillAlpha;
    ofun.addPointLong(segmentIndex, opacity, 0.5, 1.0);
  });
  ofun.setClamping(false);

  const property = actor.getProperty();
  property.setRGBTransferFunction(0, cfun);
  property.setScalarOpacity(0, ofun);
  // Nearest interpolation keeps label indices exact (no blending between
  // neighboring segment indices producing wrong colors).
  property.setInterpolationTypeToNearest();
  property.setUseGradientOpacity?.(0, false);
  // Match anatomy volume lighting so Shade / Ambient / Diffuse on the presets
  // panel also affect segment surfaces (reduces flat "cartoon" look).
  applyVolumetricSegmentLighting(property, getAnatomyVolumeLighting(viewport));
}

function getVolumetricActorEntry(viewport: Types.IVolumeViewport, actorUID: string) {
  return viewport.getActors().find(entry => entry.uid === actorUID);
}

/**
 * Adds volumetric labelmap actors for any viewport segmentation that doesn't
 * have one yet. Idempotent.
 */
async function addMissingVolumetricActors(
  viewport: Types.IVolumeViewport,
  state: VolumetricState
): Promise<void> {
  const viewportId = viewport.id;
  const segmentationIds = getViewportSegmentationIds(viewportId);

  for (const segmentationId of segmentationIds) {
    if (state.entries.some(entry => entry.segmentationId === segmentationId)) {
      continue;
    }

    try {
      const volumeId = await ensureLabelmapVolume(segmentationId);
      if (!volumeId) {
        continue;
      }

      // Deliberately NOT `${segmentationId}-Labelmap...`: cornerstone's
      // getLabelmapActorEntries matches that prefix and would start treating
      // our actor as a regular labelmap representation actor.
      const representationUID = `volumetric-segment-${segmentationId}`;

      await viewport.addVolumes(
        [
          {
            volumeId,
            visibility: true,
            representationUID,
            // Colored segment overlay (not MIP); default mapper blend is fine
            // on VolumeViewport3D but set explicitly for clarity.
            blendMode: Enums.BlendModes.COMPOSITE,
          },
        ],
        false,
        true
      );

      const actorEntry = viewport
        .getActors()
        .find(entry => (entry as { representationUID?: string }).representationUID === representationUID);
      if (!actorEntry) {
        continue;
      }

      state.entries.push({ segmentationId, volumeId, actorUID: actorEntry.uid });

      let viewportSet = volumetricVolumeIds.get(viewportId);
      if (!viewportSet) {
        viewportSet = new Set();
        volumetricVolumeIds.set(viewportId, viewportSet);
      }
      viewportSet.add(volumeId);

      applyLabelmapTransferFunctions(viewport, segmentationId, actorEntry.actor);
    } catch (error) {
      console.warn(
        `[volumetricSegmentDisplay] Failed to add volumetric labelmap for ${segmentationId}:`,
        error
      );
    }
  }
}

/**
 * Drops volumetric actors whose segmentations were removed from the viewport.
 */
function removeStaleVolumetricActors(
  viewport: Types.IVolumeViewport,
  state: VolumetricState
): void {
  const activeIds = new Set(getViewportSegmentationIds(viewport.id));
  const stale = state.entries.filter(entry => !activeIds.has(entry.segmentationId));
  if (!stale.length) {
    return;
  }
  const staleUIDs = stale.map(entry => entry.actorUID).filter(uid =>
    viewport.getActors().some(a => a.uid === uid)
  );
  if (staleUIDs.length) {
    viewport.removeVolumeActors(staleUIDs, false);
  }
  state.entries = state.entries.filter(entry => activeIds.has(entry.segmentationId));
}

/**
 * Re-applies transfer functions (colors, per-segment visibility, fillAlpha),
 * picks up newly added segmentations, and removes stale actors.
 */
async function refreshVolumetricSegments(
  viewport: Types.IVolumeViewport,
  state: VolumetricState
): Promise<void> {
  removeStaleVolumetricActors(viewport, state);
  await addMissingVolumetricActors(viewport, state);
  state.entries.forEach(({ segmentationId, actorUID }) => {
    const actorEntry = getVolumetricActorEntry(viewport, actorUID);
    if (actorEntry) {
      applyLabelmapTransferFunctions(viewport, segmentationId, actorEntry.actor);
    }
  });
  viewport.render();
}

/**
 * Enables volumetric labelmap rendering of all segmentations on a 3D viewport
 * and subscribes to segmentation events to keep colors/visibility and the GPU
 * texture in sync (the stock Cornerstone listeners skip VolumeViewport3D).
 */
export async function enableVolumetricSegments(viewport: Types.IVolumeViewport): Promise<void> {
  const viewportId = viewport.id;
  const existing = volumetricStates.get(viewportId);
  if (existing) {
    await refreshVolumetricSegments(viewport, existing);
    return;
  }

  const state: VolumetricState = { entries: [], cleanup: () => {} };
  volumetricStates.set(viewportId, state);

  await addMissingVolumetricActors(viewport, state);
  state.entries.forEach(({ segmentationId, actorUID }) => {
    const actorEntry = getVolumetricActorEntry(viewport, actorUID);
    if (actorEntry) {
      applyLabelmapTransferFunctions(viewport, segmentationId, actorEntry.actor);
    }
  });
  viewport.render();

  // Brush/scissor edits: update the GPU texture (mirrors Cornerstone's
  // performVolumeLabelmapUpdate, which never runs for VolumeViewport3D).
  const onDataModified = evt => {
    const { segmentationId, modifiedSlicesToUse } = evt.detail ?? {};
    const entry = state.entries.find(e => e.segmentationId === segmentationId);
    if (!entry) {
      return;
    }
    const volume = cache.getVolume(entry.volumeId);
    if (!volume) {
      return;
    }
    const { imageData, vtkOpenGLTexture } = volume as {
      imageData?: { getDimensions: () => number[]; modified: () => void };
      vtkOpenGLTexture?: { setUpdatedFrame: (frame: number) => void };
    };
    if (!imageData) {
      return;
    }
    const slices: number[] = modifiedSlicesToUse?.length
      ? modifiedSlicesToUse
      : [...Array(imageData.getDimensions()[2]).keys()];
    slices.forEach(slice => vtkOpenGLTexture?.setUpdatedFrame(slice));
    imageData.modified();
    viewport.render();
  };

  // Color / visibility / style changes and newly hydrated segmentations.
  const onSegmentationModified = () => {
    refreshVolumetricSegments(viewport, state).catch(error =>
      console.warn('[volumetricSegmentDisplay] refresh failed:', error)
    );
  };

  eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, onDataModified);
  eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_MODIFIED, onSegmentationModified);
  eventTarget.addEventListener(
    csToolsEnums.Events.SEGMENTATION_REPRESENTATION_MODIFIED,
    onSegmentationModified
  );
  // Hydration adds representations via ADDED, not MODIFIED.
  eventTarget.addEventListener(
    csToolsEnums.Events.SEGMENTATION_REPRESENTATION_ADDED,
    onSegmentationModified
  );
  eventTarget.addEventListener(
    csToolsEnums.Events.SEGMENTATION_REPRESENTATION_REMOVED,
    onSegmentationModified
  );

  state.cleanup = () => {
    eventTarget.removeEventListener(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, onDataModified);
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_MODIFIED,
      onSegmentationModified
    );
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_MODIFIED,
      onSegmentationModified
    );
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_ADDED,
      onSegmentationModified
    );
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_REMOVED,
      onSegmentationModified
    );
  };
}

/**
 * Refreshes volumetric actors when the viewport is already in volumetric mode
 * (e.g. a segmentation hydrated after the user switched modes).
 */
export async function refreshVolumetricSegmentsIfEnabled(
  viewport: Types.IVolumeViewport
): Promise<void> {
  const state = volumetricStates.get(viewport.id);
  if (!state) {
    return;
  }
  await refreshVolumetricSegments(viewport, state);
}

/**
 * Removes the volumetric labelmap actors and event subscriptions from the
 * viewport (used when switching back to a surface-based mode).
 */
export function disableVolumetricSegments(viewport: Types.IVolumeViewport): void {
  const state = volumetricStates.get(viewport.id);
  if (!state) {
    return;
  }
  state.cleanup();
  const actorUIDs = state.entries.map(entry => entry.actorUID);
  if (actorUIDs.length) {
    viewport.removeVolumeActors(actorUIDs, false);
  }
  volumetricStates.delete(viewport.id);
}

/**
 * Whether volumetric segment rendering is currently active on the viewport.
 */
export function isVolumetricSegmentsEnabled(viewport: Types.IVolumeViewport): boolean {
  return volumetricStates.has(viewport.id);
}
