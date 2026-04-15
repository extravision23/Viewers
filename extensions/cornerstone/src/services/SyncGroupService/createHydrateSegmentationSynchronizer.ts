import { Enums as CoreEnums, Types, getEnabledElementByViewportId } from '@cornerstonejs/core';
import {
  SynchronizerManager,
  Synchronizer,
  Enums,
  Types as ToolsTypes,
} from '@cornerstonejs/tools';

import { isAnyDisplaySetCommon } from '../../utils/isAnyDisplaySetCommon';

const { createSynchronizer } = SynchronizerManager;
const { SEGMENTATION_REPRESENTATION_MODIFIED } = Enums.Events;
const { BlendModes } = CoreEnums;

// Global in-flight map to prevent concurrent duplicate adds across callbacks
const inFlight = new Map<string, Promise<void>>();

export default function createHydrateSegmentationSynchronizer(
  synchronizerName: string,
  { servicesManager, ...options }: { servicesManager: AppTypes.ServicesManager; options }
): Synchronizer {
  const stackImageSynchronizer = createSynchronizer(
    synchronizerName,
    SEGMENTATION_REPRESENTATION_MODIFIED,
    (synchronizerInstance, sourceViewport, targetViewport, sourceEvent) => {
      return segmentationRepresentationModifiedCallback(
        synchronizerInstance,
        sourceViewport,
        targetViewport,
        sourceEvent,
        { servicesManager, options }
      );
    },
    {
      eventSource: 'eventTarget',
    }
  );

  return stackImageSynchronizer;
}

/**
 * This method will add the segmentation representation to any target viewports having:
 *
 * 1. the same FrameOfReferenceUID (FOR) as the segmentation representation, or
 * 2. a shared DisplaySet with the source viewport when no FOR is present.
 */
const segmentationRepresentationModifiedCallback = async (
  synchronizerInstance: Synchronizer,
  sourceViewport: Types.IViewportId,
  targetViewport: Types.IViewportId,
  sourceEvent: Event,
  { servicesManager, options }: { servicesManager: AppTypes.ServicesManager; options: unknown }
) => {
  const event = sourceEvent as ToolsTypes.EventTypes.SegmentationRepresentationModifiedEventType;

  const { segmentationId, type: segmentationRepresentationType } = event.detail;
  const { segmentationService, cornerstoneViewportService } = servicesManager.services;

  const targetViewportId = targetViewport.viewportId;
  const sourceViewportId = sourceViewport.viewportId;

  // Do not hydrate back into the source viewport
  if (targetViewportId === sourceViewportId) {
    return;
  }

  const { viewport } = getEnabledElementByViewportId(targetViewportId);
  const sourceViewportInfo = cornerstoneViewportService.getViewportInfo(sourceViewportId);
  const targetViewportInfo = cornerstoneViewportService.getViewportInfo(targetViewportId);

  const sourceDisplaySetUIDs = extractDisplaySetUIDs(sourceViewportInfo);
  const targetDisplaySetUIDs = extractDisplaySetUIDs(targetViewportInfo);

  const sharedDisplaySetExists = isAnyDisplaySetCommon(sourceDisplaySetUIDs, targetDisplaySetUIDs);

  const { viewport: sourceCsViewport } = getEnabledElementByViewportId(sourceViewportId);
  const sourceFOR = sourceCsViewport.getFrameOfReferenceUID?.();
  const targetFOR = viewport.getFrameOfReferenceUID?.();

  // If both source and target have FOR, they must match
  if (sourceFOR && targetFOR && sourceFOR !== targetFOR) {
    return;
  }

  // If target FOR is missing, require a shared display set
  if (!targetFOR && !sharedDisplaySetExists) {
    return;
  }

  const isVolume3D = viewport.type === CoreEnums.ViewportType.VOLUME_3D;

  console.debug('[Hydrator] Processing hydration:', {
    sourceViewportId,
    targetViewportId,
    segmentationId,
    sourceType: segmentationRepresentationType,
    isVolume3D,
  });

  // For 3D viewports, ensure BOTH Labelmap (for UI) and Surface (for rendering) exist.
  // For non-3D, keep existing behavior and only ensure the event's type (or Labelmap) exists.
  const typesToEnsure: Enums.SegmentationRepresentations[] = isVolume3D
    ? [Enums.SegmentationRepresentations.Labelmap, Enums.SegmentationRepresentations.Surface]
    : [
        (segmentationRepresentationType as Enums.SegmentationRepresentations) ??
          Enums.SegmentationRepresentations.Labelmap,
      ];

  console.debug('[Hydrator] Types to ensure:', typesToEnsure);

  for (const type of typesToEnsure) {
    // Check if representation of this specific type already exists
    const targetViewportRepresentation = segmentationService.getSegmentationRepresentations(
      targetViewportId,
      { segmentationId, type }
    );

    if (targetViewportRepresentation.length > 0) {
      // Representation of this type already exists, skip
      console.debug('[Hydrator] Representation already exists, skipping:', {
        targetViewportId,
        segmentationId,
        type,
      });
      continue;
    }

    const key = `${targetViewportId}|${segmentationId}|${type}`;
    if (inFlight.has(key)) {
      // Representation add for this key is already in-flight, skip
      console.debug('[Hydrator] Representation add already in-flight, skipping:', {
        targetViewportId,
        segmentationId,
        type,
        key,
      });
      continue;
    }

    console.debug('[Hydrator] Adding representation:', {
      targetViewportId,
      segmentationId,
      type,
    });

    const p = (async () => {
      // Double-check existence before add to avoid race conditions
      const reps = segmentationService.getSegmentationRepresentations(targetViewportId, {
        segmentationId,
        type,
      });
      if (reps.length) {
        console.debug('[Hydrator] Representation already exists after double-check, skipping:', {
          targetViewportId,
          segmentationId,
          type,
        });
        return;
      }

      // Preserve existing blendMode behavior for Surface in appropriate cases
      let blendMode: CoreEnums.BlendModes | undefined;
      if (type === Enums.SegmentationRepresentations.Surface) {
        blendMode =
          viewport.getBlendMode() === 1
            ? BlendModes.LABELMAP_EDGE_PROJECTION_BLEND
            : undefined;
      }

      await segmentationService.addSegmentationRepresentation(targetViewportId, {
        segmentationId,
        type,
        config: blendMode ? { blendMode } : undefined,
      });

      console.debug('[Hydrator] Successfully added representation:', {
        targetViewportId,
        segmentationId,
        type,
      });
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    await p;
  }
};

/**
 * Extracts the displaySetInstanceUIDs from a viewportInfo.
 */
function extractDisplaySetUIDs(viewportInfo) {
  return viewportInfo.getViewportData().data.map(ds => ds.displaySetInstanceUID);
}
