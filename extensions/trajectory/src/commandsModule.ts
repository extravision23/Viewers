import dcmjs from 'dcmjs';
import { Types } from '@ohif/core';
import { utilities as csUtils } from '@cornerstonejs/core';
import { buildFunctionUrl } from '@ohif/app/src/utils/buildFunctionUrl';
import TrajectoryPlannerDialog from './components/TrajectoryPlannerDialog';

function getAuthHeader(dataSource) {
  const bearer = dataSource?.retrieve?.customClient?.headers?.Authorization;
  return bearer ? { Authorization: bearer } : {};
}

async function readConvertResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  const text = await response.text();
  return {
    artifacts: text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.toLowerCase().startsWith('uploaded'))
      .map(blobPath => ({
        format: blobPath.toLowerCase().endsWith('.glb') ? 'glb' : 'obj',
        blobPath,
      })),
  };
}

function appendQueryParam(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function getActiveViewportWindowLevel(servicesManager, viewportGridService) {
  const defaults = { center: 40, width: 400 };
  try {
    const { cornerstoneViewportService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) {
      return defaults;
    }
    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    const properties = viewport?.getProperties?.();
    const voiRange = properties?.voiRange;
    if (voiRange?.lower !== undefined && voiRange?.upper !== undefined) {
      const { windowWidth, windowCenter } = csUtils.windowLevel.toWindowLevel(
        voiRange.lower,
        voiRange.upper
      );
      return { center: windowCenter, width: windowWidth };
    }
  } catch {
    // defaults
  }
  return defaults;
}

function getVisibleSegmentNumbers(
  segmentationId: string,
  segmentationService: any,
  viewportGridService: any
): number[] {
  try {
    const segmentation = segmentationService.getSegmentation(segmentationId);
    if (!segmentation?.segments) {
      return [];
    }
    const viewportIds = segmentationService.getViewportIdsWithSegmentation(segmentationId);
    const viewportId =
      viewportIds[0] || viewportGridService.getState()?.activeViewportId;
    if (!viewportId) {
      return Object.keys(segmentation.segments).map(Number);
    }
    const visible = segmentationService.getVisibleSegmentIndices?.(segmentationId, viewportId);
    if (visible?.length) {
      return visible;
    }
    return Object.keys(segmentation.segments).map(Number);
  } catch {
    return [];
  }
}

export default function commandsModule({
  servicesManager,
  extensionManager,
  commandsManager,
}: Types.Extensions.ExtensionParams) {
  const { segmentationService, uiNotificationService, uiDialogService, viewportGridService } =
    servicesManager.services as AppTypes.Services;

  const actions = {
    openTrajectoryPlanner: async ({
      segmentationId,
      dataSource,
      noCache = false,
      meshQuality = 'preview',
    }) => {
      const loadingNotificationId = uiNotificationService.show({
        title: 'Trajectory Planner',
        message: 'Converting segmentation to 3D meshes…',
        type: 'info',
        duration: 0,
      });

      try {
        const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
        if (!segmentationInOHIF) {
          throw new Error('Segmentation not found');
        }

        const generated = await commandsManager.runCommand('generateSegmentation', {
          segmentationId,
        });
        if (!generated?.dataset) {
          throw new Error('Failed to generate segmentation dataset.');
        }

        const dicomBlob = dcmjs.data.datasetToBlob(generated.dataset);
        const formData = new FormData();
        formData.append('file', dicomBlob, `${segmentationInOHIF.label}.dcm`);
        formData.append('format', 'glb');
        formData.append('response', 'json');
        formData.append('meshQuality', meshQuality);

        const anatomyWindow = getActiveViewportWindowLevel(servicesManager, viewportGridService);
        formData.append('anatomyWindowCenter', String(anatomyWindow.center));
        formData.append('anatomyWindowWidth', String(anatomyWindow.width));

        const selectedSegmentNumbers = getVisibleSegmentNumbers(
          segmentationId,
          segmentationService,
          viewportGridService
        );
        if (selectedSegmentNumbers?.length) {
          formData.append('segments', selectedSegmentNumbers.join(','));
        }

        const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
        const config = defaultDataSource.getConfig();
        const baseEndpoint = buildFunctionUrl(config, 'ConvertDicomToObj');
        const endpoint = noCache
          ? appendQueryParam(baseEndpoint, 'forceRegenerate', '1')
          : baseEndpoint;

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
          headers: { ...getAuthHeader(defaultDataSource) },
        });

        if (loadingNotificationId) {
          uiNotificationService.hide(loadingNotificationId);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          throw new Error(`Server error: ${response.status} ${errorText}`);
        }

        const payload = await readConvertResponse(response);
        const glbArtifacts = (payload?.artifacts || []).filter(
          (item: { format?: string; url?: string }) =>
            String(item.format || '').toLowerCase() === 'glb' && item?.url
        );
        if (!glbArtifacts.length) {
          throw new Error('GLB URL is missing in conversion response.');
        }

        const displaySet = servicesManager.services.displaySetService?.getDisplaySetByUID?.(
          segmentationId
        );
        const studyInstanceUID = displaySet?.StudyInstanceUID;

        uiDialogService.show({
          id: 'trajectory-planner',
          title: 'Trajectory Planner',
          content: TrajectoryPlannerDialog,
          shouldCloseOnEsc: true,
          contentProps: {
            models: glbArtifacts.map(
              (item: { url: string; label?: string; segmentNumber?: number }) => ({
                url: item.url,
                label: item.label,
                segmentNumber: item.segmentNumber,
              })
            ),
            title: segmentationInOHIF.label,
            segmentationId,
            studyInstanceUID,
          },
          containerClassName: 'max-w-[98vw]',
        });
      } catch (error) {
        if (loadingNotificationId) {
          uiNotificationService.hide(loadingNotificationId);
        }
        uiNotificationService.show({
          title: 'Trajectory Planner Failed',
          message: error?.message || 'Failed to open trajectory planner',
          type: 'error',
          duration: 5000,
        });
      }
    },
  };

  const definitions = {
    openTrajectoryPlanner: {
      commandFn: actions.openTrajectoryPlanner,
      storeContexts: [],
      options: {},
    },
  };

  return { actions, definitions, defaultContext: 'TRAJECTORY' };
}
