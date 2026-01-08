import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';
import { callInputDialog } from '@ohif/extension-default';
import { cache } from '@cornerstonejs/core';

/**
 * Error thrown when user cancels the segmentation save operation
 */
export class UserCancelledError extends Error {
  constructor() {
    super('User cancelled the operation');
    this.name = 'UserCancelledError';
  }
}

/**
 * Ensures there is a saved segmentation with a DICOM SEG SeriesInstanceUID
 * available for server-side processing. This function handles three scenarios:
 *
 * 1. Active segmentation is already saved -> Returns its SeriesInstanceUID
 * 2. Active segmentation exists but not saved -> Prompts user for name and saves it
 * 3. No active segmentation -> Creates one, prompts for name, and saves it
 *
 * @param params - Function parameters
 * @param params.viewportId - Target viewport ID (uses active viewport if not provided)
 * @param params.servicesManager - OHIF services manager
 * @param params.extensionManager - OHIF extension manager
 * @param params.storeSegmentationAction - Direct reference to storeSegmentation action function
 * @returns Promise resolving to object with segmentationSeriesInstanceUID (may be undefined for empty unsaved segmentations) and segmentationId
 * @throws {UserCancelledError} If user cancels the name prompt
 * @throws {Error} If save operation fails
 */
export async function ensureSavedSegmentationForServerCall({
  viewportId,
  servicesManager,
  extensionManager,
  storeSegmentationAction,
}: {
  viewportId?: string;
  servicesManager: AppTypes.ServicesManager;
  extensionManager: any;
  storeSegmentationAction: (params: { segmentationId: string; modality: string }) => Promise<any>;
}): Promise<{
  segmentationSeriesInstanceUID: string | undefined;
  segmentationId: string;
}> {
  const {
    segmentationService,
    viewportGridService,
    displaySetService,
    uiDialogService,
    uiNotificationService,
  } = servicesManager.services as AppTypes.Services;

  // Step 1: Determine target viewport
  const { activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  if (!targetViewportId) {
    throw new Error('No active viewport found');
  }

  // Step 2: Get active segmentation for viewport
  const activeSegmentation = segmentationService.getActiveSegmentation(targetViewportId);
  const segmentationId = activeSegmentation?.segmentationId;

  // Step 3: If no active segmentation, show error
  if (!segmentationId) {
    uiNotificationService.show({
      title: 'No Segmentation',
      message: 'Please create a segmentation first before using server-side segmentation tools.',
      type: 'warning',
      duration: 5000,
    });
    throw new UserCancelledError();
  }

  // Step 4: Check if segmentation is already saved
  const displaySet = displaySetService.getDisplaySetByUID(segmentationId);
  const isSaved = displaySet && displaySet.SeriesInstanceUID && !displaySet.madeInClient;
  console.group('[ensureSavedSegmentationForServerCall] PRE isSaved');

  console.log('viewportId:', targetViewportId);
  console.log('active segmentationId:', segmentationId);

  console.log(
    'activeSegmentation (raw):',
    segmentationService.getActiveSegmentation(targetViewportId)
  );
  console.log('getDisplaySetByUID(segmentationId):', displaySet);
  const allDisplaySets = displaySetService.getDisplaySetsForSeries(
    displaySet.SeriesInstanceUID
  );
  console.log(
    'ALL displaySets (uid, modality, seriesUID):',
    allDisplaySets?.map(ds => ({
      displaySetInstanceUID: ds.displaySetInstanceUID,
      modality: ds.Modality,
      seriesInstanceUID: ds.SeriesInstanceUID,
      madeInClient: ds.madeInClient,
    }))
  );

  console.groupEnd();

  if (isSaved && displaySet.SeriesInstanceUID) {
    console.debug('ensureSavedSegmentationForServerCall: already saved');
    console.log('segmentationId:', segmentationId);
    console.log('displaySetInstanceUID:', displaySet.displaySetInstanceUID);
    console.log('SeriesInstanceUID USED:', displaySet.SeriesInstanceUID);
    console.log('madeInClient:', displaySet?.madeInClient);

    console.groupEnd();
    return {
      segmentationSeriesInstanceUID: displaySet.SeriesInstanceUID,
      segmentationId,
    };
  }

  // Step 5: Segmentation is not saved - check if it's empty
  const segmentation = segmentationService.getSegmentation(segmentationId);
  const isEmpty = isSegmentationEmpty(segmentation, segmentationId);

  if (isEmpty) {
    console.debug('ensureSavedSegmentationForServerCall: unsaved+empty skip store');
    return {
      segmentationSeriesInstanceUID: undefined,
      segmentationId,
    };
  }

  // Step 6: Segmentation is not saved and has content - prompt user for name
  const defaultName = segmentation?.label || `Segmentation ${Date.now()}`;

  const segmentationName = await callInputDialog({
    uiDialogService,
    title: 'Save Segmentation',
    placeholder: 'Enter segmentation name',
    defaultValue: defaultName,
    submitOnEnter: true,
  });

  if (segmentationName == null || segmentationName.trim() === '') {
    throw new UserCancelledError();
  }

  console.debug('ensureSavedSegmentationForServerCall: unsaved+non-empty will store');

  // Update segmentation label (краще через addOrUpdate, не мутати напряму)
  segmentationService.addOrUpdateSegmentation({ segmentationId, label: segmentationName });

  // Step 7: Save segmentation
  try {
    await ensureLabelmapRepForSegmentation({ viewportId: targetViewportId, segmentationId });
    segmentationService.setActiveSegmentation(targetViewportId, segmentationId);

    // optional: повторно глянути volume cached, якщо хочеш
    const seg = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
    const lm = seg?.representationData?.Labelmap;
    if (!lm?.volumeId || !cache.getVolume(lm.volumeId)) {
      // якщо volume нема — не ризикуємо storeSegmentation
      console.debug('ensureSavedSegmentationForServerCall: labelmap volume not ready -> skip store');
      return { segmentationSeriesInstanceUID: undefined, segmentationId };
    }

    const naturalizedReport = await storeSegmentationAction({ segmentationId, modality: 'SEG' });

    if (!naturalizedReport?.SeriesInstanceUID) {
      throw new Error('Failed to get SeriesInstanceUID from saved segmentation');
    }

    console.debug('ensureSavedSegmentationForServerCall: unsaved+non-empty stored');

    return {
      segmentationSeriesInstanceUID: naturalizedReport.SeriesInstanceUID,
      segmentationId,
    };
  } catch (error: any) {
    // Check if it was a user cancellation from the report dialog
    if (error.message === 'Save operation was cancelled') {
      throw new UserCancelledError();
    }

    // Show error notification
    uiNotificationService.show({
      title: 'Save Failed',
      message: error.message || 'Failed to save segmentation',
      type: 'error',
      duration: 5000,
    });

    throw new Error(`Failed to save segmentation: ${error.message}`);
  }
}

/**
 * Checks if a segmentation is empty (has no actual content)
 * A segmentation is considered empty if:
 * 1. It has no segments defined, OR
 * 2. It has segments but the labelmap volume has no non-zero voxels
 *
 * @param segmentation - The segmentation object from segmentationService
 * @param segmentationId - The segmentation ID
 * @returns true if segmentation is empty, false otherwise
 */
function isSegmentationEmpty(
  segmentation: any,
  segmentationId: string
): boolean {
  // Check if segmentation exists
  if (!segmentation) {
    return true;
  }

  // Check if segments object is empty
  const segments = segmentation.segments;
  if (!segments || Object.keys(segments).length === 0) {
    return true;
  }

  // Try to check if labelmap has any non-zero voxels
  // Get the cornerstone segmentation state
  const csSegmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
  if (!csSegmentation) {
    return true;
  }

  const labelmapData = csSegmentation.representationData?.Labelmap;
  if (!labelmapData) {
    // No labelmap representation - consider empty
    return true;
  }

  // Check if volume exists and has non-zero voxels
  const volumeId = labelmapData.volumeId;
  if (!volumeId) {
    return true;
  }

  const volume = cache.getVolume(volumeId);
  if (!volume) {
    return true;
  }

  // Check scalar data for non-zero values
  // Use voxelManager API if available, otherwise fall back to direct property access
  let scalarData: Uint8Array | Int16Array | Float32Array | null = null;
  if (volume.voxelManager && typeof volume.voxelManager.getCompleteScalarDataArray === 'function') {
    scalarData = volume.voxelManager.getCompleteScalarDataArray();
  } else if ((volume as any).scalarData) {
    scalarData = (volume as any).scalarData;
  }

  if (!scalarData || !scalarData.length) {
    return true;
  }

  // Sample check: look for any non-zero values
  // For performance, we sample every Nth element instead of checking all
  const sampleSize = Math.min(10000, scalarData.length);
  const step = Math.max(1, Math.floor(scalarData.length / sampleSize));

  for (let i = 0; i < scalarData.length; i += step) {
    if (scalarData[i] !== 0) {
      return false; // Found non-zero voxel
    }
  }

  // If we sampled and found nothing, do a full check for small volumes
  if (scalarData.length <= 10000) {
    for (let i = 0; i < scalarData.length; i++) {
      if (scalarData[i] !== 0) {
        return false;
      }
    }
  }

  // No non-zero voxels found
  return true;
}

async function ensureLabelmapRepForSegmentation({
  viewportId,
  segmentationId,
}: {
  viewportId: string;
  segmentationId: string;
}) {
  // 1) Перевіримо, чи вже є rep
  const reps = cornerstoneToolsSegmentation.state.getSegmentationRepresentations(viewportId) || [];
  const has = reps.some(
    r => r.segmentationId === segmentationId && r.type === SegmentationRepresentations.Labelmap
  );

  if (has) {
    return;
  }

  cornerstoneToolsSegmentation.addSegmentationRepresentations(viewportId, [
    {
      segmentationId,
      type: SegmentationRepresentations.Labelmap,
    },
  ]);
}
