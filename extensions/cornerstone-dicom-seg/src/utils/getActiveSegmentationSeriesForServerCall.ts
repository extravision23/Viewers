/**
 * Error thrown when user cancels the segmentation save operation
 */
export class UserCancelledError extends Error {
  constructor() {
    super('User cancelled the operation');
    this.name = 'UserCancelledError';
  }
}
export async function getActiveSegmentationSeriesForServerCall({
  viewportId,
  servicesManager,
}: {
  viewportId?: string;
  servicesManager: AppTypes.ServicesManager;
}): Promise<{
  segmentationSeriesInstanceUID?: string;
  segmentationId?: string;
}> {
  const { segmentationService, viewportGridService, displaySetService } =
    servicesManager.services as AppTypes.Services;

  const { activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  if (!targetViewportId) {
    throw new Error('No active viewport found');
  }

  // If user has a loaded/active segmentation in viewport, it should be here
  const activeSeg = segmentationService.getActiveSegmentation(targetViewportId);
  const segmentationId = activeSeg?.segmentationId;

  if (!segmentationId) {
    // No active segmentation => call server WITHOUT segmentationSeriesInstanceUID
    return { segmentationSeriesInstanceUID: undefined, segmentationId: undefined };
  }

  // Map segmentationId -> displaySet -> SeriesInstanceUID
  const displaySet = displaySetService.getDisplaySetByUID(segmentationId);
  const seriesUID = displaySet?.SeriesInstanceUID;

  return {
    segmentationSeriesInstanceUID: seriesUID,
    segmentationId,
  };
}
