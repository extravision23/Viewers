import dcmjs from 'dcmjs';
import { classes, Types, utils } from '@ohif/core';
import { cache, metaData } from '@cornerstonejs/core';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';
import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';
import { adaptersRT, adaptersSEG } from '@cornerstonejs/adapters';
import { createReportDialogPrompt, useUIStateStore } from '@ohif/extension-default';

import PROMPT_RESPONSES from '../../default/src/utils/_shared/PROMPT_RESPONSES';
import {
  ensureSavedSegmentationForServerCall,
  UserCancelledError,
} from './utils/ensureSavedSegmentationForServerCall';

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

const getFunctionsBaseUrl = dataSourceConfig => {
  return (
    dataSourceConfig?.pythonFunctionsBaseUrl ||
    (dataSourceConfig?.pythonFunctionName
      ? `https://${dataSourceConfig.pythonFunctionName}.azurewebsites.net/api`
      : undefined)
  );
};

const buildFunctionUrl = (dataSourceConfig, functionName: string) => {
  const baseUrl = getFunctionsBaseUrl(dataSourceConfig);
  if (!baseUrl) {
    throw new Error('No python functions base url configured');
  }
  return `${baseUrl}/${functionName}`;
};

const {
  Cornerstone3D: {
    Segmentation: { generateSegmentation },
  },
} = adaptersSEG;

const {
  Cornerstone3D: {
    RTSS: { generateRTSSFromRepresentation },
  },
} = adaptersRT;


function getAuthHeader(dataSource) {
  const bearer = dataSource?.retrieve?.customClient?.headers?.Authorization;
  return bearer ? { Authorization: bearer } : {};
}

const commandsModule = ({
  servicesManager,
  extensionManager,
  commandsManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const { segmentationService, displaySetService, viewportGridService } =
    servicesManager.services as AppTypes.Services;

  const actions = {
    /**
     * Loads segmentations for a specified viewport.
     * The function prepares the viewport for rendering, then loads the segmentation details.
     * Additionally, if the segmentation has scalar data, it is set for the corresponding label map volume.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentations - Array of segmentations to be loaded.
     * @param params.viewportId - the target viewport ID.
     *
     */
    loadSegmentationsForViewport: async ({ segmentations, viewportId }) => {
      // Todo: handle adding more than one segmentation
      const viewport = getTargetViewport({ viewportId, viewportGridService });
      const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];

      const segmentation = segmentations[0];
      const segmentationId = segmentation.segmentationId;
      const label = segmentation.config.label;
      const segments = segmentation.config.segments;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        segments,
        label,
      });

      segmentationService.addOrUpdateSegmentation(segmentation);

      await segmentationService.addSegmentationRepresentation(viewport.viewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    /**
     * Generates a segmentation from a given segmentation ID.
     * This function retrieves the associated segmentation and
     * its referenced volume, extracts label maps from the
     * segmentation volume, and produces segmentation data
     * alongside associated metadata.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be generated.
     * @param params.options - Optional configuration for the generation process.
     *
     * @returns Returns the generated segmentation data.
     */
    generateSegmentation: ({ segmentationId, options = {} }) => {
      const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
      const predecessorImageId = options.predecessorImageId ?? segmentation.predecessorImageId;

      const { imageIds } = segmentation.representationData.Labelmap;

      const segImages = imageIds.map(imageId => cache.getImage(imageId));
      const referencedImages = segImages.map(image => cache.getImage(image.referencedImageId));

      const labelmaps2D = [];

      let z = 0;

      for (const segImage of segImages) {
        const segmentsOnLabelmap = new Set();
        const pixelData = segImage.getPixelData();
        const { rows, columns } = segImage;

        // Use a single pass through the pixel data
        for (let i = 0; i < pixelData.length; i++) {
          const segment = pixelData[i];
          if (segment !== 0) {
            segmentsOnLabelmap.add(segment);
          }
        }

        labelmaps2D[z++] = {
          segmentsOnLabelmap: Array.from(segmentsOnLabelmap),
          pixelData,
          rows,
          columns,
        };
      }

      const allSegmentsOnLabelmap = labelmaps2D.map(labelmap => labelmap.segmentsOnLabelmap);

      const labelmap3D = {
        segmentsOnLabelmap: Array.from(new Set(allSegmentsOnLabelmap.flat())),
        metadata: [],
        labelmaps2D,
      };

      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const representations = segmentationService.getRepresentationsForSegmentation(segmentationId);

      Object.entries(segmentationInOHIF.segments).forEach(([segmentIndex, segment]) => {
        // segmentation service already has a color for each segment
        if (!segment) {
          return;
        }

        const { label } = segment;

        const firstRepresentation = representations[0];
        const color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segment.segmentIndex
        );

        const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
          color.slice(0, 3).map(value => value / 255)
        ).map(value => Math.round(value));

        const segmentMetadata = {
          SegmentNumber: segmentIndex.toString(),
          SegmentLabel: label,
          SegmentAlgorithmType: segment?.algorithmType || 'MANUAL',
          SegmentAlgorithmName: segment?.algorithmName || 'OHIF Brush',
          RecommendedDisplayCIELabValue,
          SegmentedPropertyCategoryCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
          SegmentedPropertyTypeCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
        };
        labelmap3D.metadata[segmentIndex] = segmentMetadata;
      });

      const generatedSegmentation = generateSegmentation(referencedImages, labelmap3D, metaData, {
        predecessorImageId,
        ...options,
      });

      return generatedSegmentation;
    },
    /**
     * Downloads a segmentation based on the provided segmentation ID.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    downloadSegmentation: ({ segmentationId }) => {
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const generatedSegmentation = actions.generateSegmentation({
        segmentationId,
      });
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `${segmentationInOHIF.label}.dcm`,
      });
      storeFn(generatedSegmentation.dataset);
    },
    /**
     * Stores a segmentation based on the provided segmentationId into a specified data source.
     * The SeriesDescription is derived from user input or defaults to the segmentation label,
     * and in its absence, defaults to 'Research Derived Series'.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be stored.
     * @param params.dataSource - Data source where the generated segmentation will be stored.
     *
     * @returns {Object|void} Returns the naturalized report if successfully stored,
     * otherwise throws an error.
     */
    storeSegmentation: async ({ segmentationId, dataSource, modality = 'SEG' }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        throw new Error('No segmentation found');
      }

      const { label, predecessorImageId } = segmentation;

      const {
        value: reportName,
        dataSourceName,
        series,
        priorSeriesNumber,
        action,
      } = await createReportDialogPrompt({
        servicesManager,
        extensionManager,
        predecessorImageId,
        title: 'Store Segmentation',
        modality,
        enableDownload: true,
      });

      if (action !== PROMPT_RESPONSES.CREATE_REPORT) {
        return;
      }

      const defaultFileName =
        modality === 'RTSTRUCT'
          ? `rtss-${segmentationId}.dcm`
          : `${label || 'segmentation'}.dcm`;

      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: dataSourceName,
        defaultFileName,
      });

      if (!storeFn) {
        throw new Error(`No valid store for dataSource: ${dataSourceName}`);
      }

      try {
        const args = {
          segmentationId,
          options: {
            SeriesDescription: series ? undefined : reportName || label || 'Contour Series',
            SeriesNumber: series ? undefined : 1 + priorSeriesNumber,
            predecessorImageId: series,
          },
        };
        const generatedDataAsync =
          (modality === 'SEG' && actions.generateSegmentation(args)) ||
          (modality === 'RTSTRUCT' && actions.generateContour(args));
        const generatedData = await generatedDataAsync;

        if (!generatedData?.dataset) {
          throw new Error('Error during segmentation generation');
        }

        const { dataset: naturalizedReport } = generatedData;

        // DCMJS assigns a dummy study id during creation, and this can cause problems, so clearing it out
        if (naturalizedReport.StudyID === 'No Study ID') {
          naturalizedReport.StudyID = '';
        }

        await storeFn(naturalizedReport, {});

        return naturalizedReport;
      } catch (error) {
        console.debug('Error storing segmentation:', error);
        throw error;
      }
    },

    generateContour: async args => {
      const { segmentationId, options } = args;
      const segmentations = segmentationService.getSegmentation(segmentationId);

      // inject colors to the segmentIndex
      const firstRepresentation =
        segmentationService.getRepresentationsForSegmentation(segmentationId)[0];
      Object.entries(segmentations.segments).forEach(([segmentIndex, segment]) => {
        segment.color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          Number(segmentIndex)
        );
      });
      const predecessorImageId = options?.predecessorImageId ?? segmentations.predecessorImageId;
      const dataset = await generateRTSSFromRepresentation(segmentations, {
        predecessorImageId,
        ...options,
      });
      return { dataset };
    },

    /**
     * Downloads an RTSS instance from a segmentation or contour
     * representation.
     */
    downloadRTSS: async args => {
      const { dataset } = await actions.generateContour(args);
      const { InstanceNumber: instanceNumber = 1, SeriesInstanceUID: seriesUID } = dataset;
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `rtss-${seriesUID}-${instanceNumber}.dcm`,
      });
      await storeFn(dataset);
    },

    toggleActiveSegmentationUtility: ({ itemId: buttonId }) => {
      const { uiState, setUIState } = useUIStateStore.getState();
      const isButtonActive = uiState['activeSegmentationUtility'] === buttonId;
      console.log('toggleActiveSegmentationUtility', isButtonActive, buttonId);
      // if the button is active, clear the active segmentation utility
      if (isButtonActive) {
        setUIState('activeSegmentationUtility', null);
      } else {
        setUIState('activeSegmentationUtility', buttonId);
      }
    },
    sendToGlasses: ({ segmentationId, dataSource }) => {
      try {
        const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
        const generatedSegmentation = actions.generateSegmentation({
          segmentationId,
        });

        if (!generatedSegmentation || !generatedSegmentation.dataset) {
          console.error('Failed to generate segmentation dataset.');
          return;
        }

        const dataset = generatedSegmentation.dataset;

        const dicomBlob = dcmjs.data.datasetToBlob(dataset);

        const formData = new FormData();
        formData.append('file', dicomBlob, `${segmentationInOHIF.label}.dcm`);

        const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
        const config = defaultDataSource.getConfig();

        return fetch(buildFunctionUrl(config, 'ConvertDicomToObj'), {
          method: 'POST',
          body: formData,
          headers: {
            ...getAuthHeader(defaultDataSource),
          },
        })
          .then(async response => {
            if (response.ok) {
              console.log('Segmentation sent successfully!');
              const result = await response.text();
              console.log('Server response:', result);
            } else {
              console.error(
                `Error sending segmentation. Status: ${response.status}, Text: ${response.statusText}`
              );
            }
          })
          .catch(error => {
            console.error('Error sending segmentation:', error);
          });
      } catch (error) {
        console.error('Unexpected error in sendToGlasses:', error);
      }
    },
    downloadObj: ({ segmentationId, dataSource }) => {
      try {
        // Отримання даних сегментації та генерація DICOM Blob
        const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
        const generatedSegmentation = actions.generateSegmentation({ segmentationId });

        if (!generatedSegmentation || !generatedSegmentation.dataset) {
          console.error('Failed to generate segmentation dataset.');
          return;
        }

        const dataset = generatedSegmentation.dataset;
        const dicomBlob = dcmjs.data.datasetToBlob(dataset);

        // Формуємо FormData з DICOM файлом
        const formData = new FormData();
        formData.append('file', dicomBlob, `${segmentationInOHIF.label}.dcm`);

        const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
        const config = defaultDataSource.getConfig();

        fetch(buildFunctionUrl(config, 'ConvertDicomToObjDownload'), {
          method: 'POST',
          body: formData,
          headers: {
            ...getAuthHeader(defaultDataSource),
          },
        })
          .then(async response => {
            if (response.ok) {
              // Отримуємо відповіді як blob і створюємо посилання для завантаження
              const blob = await response.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${segmentationInOHIF.label}.obj`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              window.URL.revokeObjectURL(url);
              console.log('OBJ file downloaded successfully!');
            } else {
              console.error(`Error downloading OBJ file. Status: ${response.status}`);
            }
          })
          .catch(error => {
            console.error('Error downloading OBJ file:', error);
          });
      } catch (error) {
        console.error('Unexpected error in downloadObj:', error);
      }
    },
    segmentByPreset: async ({
      studyInstanceUID,
      seriesInstanceUID,
      preset,
      customWindow,
      customSegRange,
      dataSource,
      viewportId,
    }) => {
      try {
        // Ensure we have a saved segmentation before making the server call
        let segmentationSeriesInstanceUID: string;
        try {
          const result = await ensureSavedSegmentationForServerCall({
            viewportId,
            servicesManager,
            extensionManager,
            commandsManager: { runCommand: actions },
            storeSegmentationAction: params => actions.storeSegmentation(params),
          });
          segmentationSeriesInstanceUID = result.segmentationSeriesInstanceUID;
        } catch (error) {
          if (error instanceof UserCancelledError) {
            console.log('User cancelled segmentation save, aborting server call');
            return null;
          }
          throw error;
        }

        const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
        const config = defaultDataSource.getConfig();

        const payload = {
          studyInstanceUID,
          seriesInstanceUID,
          segmentationSeriesInstanceUID,
          preset,
          customWindow,
          customSegRange,
          output: {
            mode: 'dicom_seg',
            returnMode: 'meta',
          },
        };

        const response = await fetch(buildFunctionUrl(config, 'SegmentByPreset'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(defaultDataSource),
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error('Segmentation request failed:', response.status, text);
          return;
        }

        const result = await response.json();
        console.log('Segmentation successful:', result);

        return result;
      } catch (e) {
        console.error('Error in segmentByPreset:', e);
      }
    },
    magicWandSegmentation: async ({
      studyInstanceUID,
      seriesInstanceUID,
      seed,
      options,
      dataSource,
      viewportId,
    }) => {
      try {
        // Ensure we have a saved segmentation before making the server call
        let segmentationSeriesInstanceUID: string;
        try {
          const result = await ensureSavedSegmentationForServerCall({
            viewportId,
            servicesManager,
            extensionManager,
            storeSegmentationAction: params => actions.storeSegmentation(params),
          });
          segmentationSeriesInstanceUID = result.segmentationSeriesInstanceUID;
        } catch (error) {
          if (error instanceof UserCancelledError) {
            console.log('User cancelled segmentation save, aborting server call');
            return null;
          }
          throw error;
        }

        const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
        const config = defaultDataSource.getConfig();

        // Use the same endpoint pattern as segmentByPreset
        const endpoint = buildFunctionUrl(config, 'SegmentByMagicWand');
        const payload: any = {
          studyInstanceUID,
          seriesInstanceUID,
          segmentationSeriesInstanceUID,
          seed,
        };

        // Only include options if they are provided
        if (options && Object.keys(options).length > 0) {
          payload.options = options;
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(defaultDataSource),
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error('Magic wand segmentation request failed:', response.status, text);
          throw new Error(`Segmentation request failed: ${response.status} ${text}`);
        }

        const result = await response.json();
        console.log('Magic wand segmentation successful:', result);

        return result;
      } catch (e) {
        console.error('Error in magicWandSegmentation:', e);
        throw e;
      }
    },

    /**
     * Helper: Check if a segmentation is saved (has SeriesInstanceUID and is not madeInClient)
     * @param segmentationId - The segmentation ID to check
     * @returns Object with isSaved boolean, seriesInstanceUID, and displaySet if found
     */
    isSegmentationSaved: ({ segmentationId }) => {
      const displaySet = displaySetService.getDisplaySetByUID(segmentationId);
      // madeInClient is a runtime property that may not be in TypeScript types
      const isSaved =
        displaySet && displaySet.SeriesInstanceUID && !(displaySet as any).madeInClient;
      return {
        isSaved: !!isSaved,
        seriesInstanceUID: displaySet?.SeriesInstanceUID || null,
        displaySet: displaySet || null,
      };
    },

    /**
     * Helper: Call server-side segmentation endpoint
     * @param params - Parameters for server call
     * @param params.studyInstanceUID - Study Instance UID
     * @param params.sourceSeriesInstanceUID - Source series to segment
     * @param params.segmentationSeriesInstanceUID - Optional: existing segmentation SeriesInstanceUID (Scenario B)
     * @param params.serverApi - Server API configuration (endpoint URL, etc.)
     * @param params.dataSource - DataSource for auth headers
     * @returns Promise resolving to segmentationSeriesInstanceUID
     */
    runServerSegmentation: async ({
      studyInstanceUID,
      sourceSeriesInstanceUID,
      segmentationSeriesInstanceUID,
      serverApi,
      dataSource,
    }) => {
      const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];
      const config = defaultDataSource.getConfig();

      // TODO: Replace with actual server endpoint path
      const endpoint =
        serverApi?.endpoint ||
        `https://${config.pythonFunctionName}.azurewebsites.net/api/serverSegmentation`;

      const payload: any = {
        studyInstanceUID,
        seriesInstanceUID: sourceSeriesInstanceUID,
      };

      // Scenario B: include segmentationSeriesInstanceUID for update
      if (segmentationSeriesInstanceUID) {
        payload.segmentationSeriesInstanceUID = segmentationSeriesInstanceUID;
      }

      // Merge any additional params from serverApi
      if (serverApi?.params) {
        Object.assign(payload, serverApi.params);
      }

      console.log('Calling server segmentation endpoint:', endpoint, payload);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(defaultDataSource),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('Server segmentation request failed:', response.status, text);
        throw new Error(`Server segmentation failed: ${response.status} ${text}`);
      }

      const result = await response.json();
      const returnedSegSeriesUID = result.segmentationSeriesInstanceUID;

      if (!returnedSegSeriesUID) {
        throw new Error('Server did not return segmentationSeriesInstanceUID');
      }

      console.log(
        'Server segmentation successful, returned SeriesInstanceUID:',
        returnedSegSeriesUID
      );
      return returnedSegSeriesUID;
    },

    /**
     * Helper: Load or reload SEG displaySet from DICOMweb/Azure DICOM
     * @param params - Parameters for loading
     * @param params.studyInstanceUID - Study Instance UID
     * @param params.segSeriesInstanceUID - Segmentation Series Instance UID
     * @param params.dataSource - Optional dataSource (uses active if not provided)
     * @returns Promise resolving to the loaded/updated displaySet
     */
    loadOrReloadSegDisplaySet: async ({ studyInstanceUID, segSeriesInstanceUID, dataSource }) => {
      const { uiNotificationService } = servicesManager.services as AppTypes.Services;
      const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource()[0];

      // Check if displaySet already exists for this SeriesInstanceUID
      const existingDisplaySets = displaySetService.getDisplaySetsForSeries(segSeriesInstanceUID);
      const existingSegDisplaySet = existingDisplaySets.find(ds => ds.Modality === 'SEG');

      if (existingSegDisplaySet) {
        console.log(
          'Reloading existing SEG displaySet:',
          existingSegDisplaySet.displaySetInstanceUID
        );

        // Mark metadata as invalidated to force reload
        displaySetService.setDisplaySetMetadataInvalidated(
          existingSegDisplaySet.displaySetInstanceUID,
          true
        );

        // Delete the old displaySet to force a fresh load
        displaySetService.deleteDisplaySet(existingSegDisplaySet.displaySetInstanceUID);
      }

      // Retrieve series metadata from DICOMweb
      try {
        await defaultDataSource.retrieve.series.metadata({
          StudyInstanceUID: studyInstanceUID,
          filters: {
            SeriesInstanceUID: segSeriesInstanceUID,
          },
        });

        // Wait for displaySet to be created via DicomMetadataStore events
        // Poll for up to 2 seconds with 50ms intervals
        let newSegDisplaySet = null;
        const maxWaitTime = 2000; // 2 seconds
        const pollInterval = 50; // 50ms
        const maxAttempts = maxWaitTime / pollInterval;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const updatedDisplaySets =
            displaySetService.getDisplaySetsForSeries(segSeriesInstanceUID);
          newSegDisplaySet = updatedDisplaySets.find(ds => ds.Modality === 'SEG');

          if (newSegDisplaySet) {
            break;
          }

          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        if (!newSegDisplaySet) {
          throw new Error(
            `Failed to find SEG displaySet for SeriesInstanceUID: ${segSeriesInstanceUID} after ${maxWaitTime}ms`
          );
        }

        console.log(
          'Successfully loaded/reloaded SEG displaySet:',
          newSegDisplaySet.displaySetInstanceUID
        );
        return newSegDisplaySet;
      } catch (error) {
        console.error('Error loading SEG displaySet:', error);
        uiNotificationService.show({
          title: 'Load Failed',
          message: `Failed to load segmentation series: ${error.message}`,
          type: 'error',
          duration: 5000,
        });
        throw error;
      }
    },

    /**
     * Helper: Create/update cornerstone segmentation from SEG displaySet and attach to viewport
     * @param params - Parameters for hydration
     * @param params.segDisplaySet - The SEG displaySet to hydrate from
     * @param params.viewportId - Target viewport ID
     * @param params.segmentationId - Optional: existing segmentation ID to update in-place (Scenario B)
     * @returns Promise resolving to segmentationId
     */
    hydrateSegmentationFromDisplaySet: async ({ segDisplaySet, viewportId, segmentationId }) => {
      const { uiNotificationService } = servicesManager.services as AppTypes.Services;

      try {
        // Ensure displaySet is loaded
        if (!segDisplaySet.isLoaded && segDisplaySet.load) {
          const defaultDataSource = extensionManager.getActiveDataSource()[0];
          const headers = getAuthHeader(defaultDataSource);
          await segDisplaySet.load({ headers });
        }

        // Create segmentation from SEG displaySet
        // If segmentationId is provided (Scenario B), use it to update in-place
        // Otherwise, use displaySetInstanceUID (Scenario A)
        const finalSegmentationId = await segmentationService.createSegmentationForSEGDisplaySet(
          segDisplaySet,
          {
            type: SegmentationRepresentations.Labelmap,
            segmentationId: segmentationId || segDisplaySet.displaySetInstanceUID,
          }
        );

        console.log('Hydrated segmentation from displaySet:', finalSegmentationId);
        return finalSegmentationId;
      } catch (error) {
        console.error('Error hydrating segmentation from displaySet:', error);
        uiNotificationService.show({
          title: 'Hydration Failed',
          message: `Failed to create segmentation: ${error.message}`,
          type: 'error',
          duration: 5000,
        });
        throw error;
      }
    },

    /**
     * Helper: Ensure Labelmap representation is attached to viewport and set as active
     * @param params - Parameters
     * @param params.viewportId - Target viewport ID
     * @param params.segmentationId - Segmentation ID to apply
     */
    applySegmentationToViewport: async ({ viewportId, segmentationId }) => {
      const { uiNotificationService } = servicesManager.services as AppTypes.Services;

      try {
        // Check if representation already exists
        const existingReps = segmentationService.getSegmentationRepresentations(viewportId);
        const hasLabelmapRep = existingReps.some(
          rep =>
            rep.segmentationId === segmentationId &&
            rep.type === SegmentationRepresentations.Labelmap
        );

        if (!hasLabelmapRep) {
          // Add Labelmap representation to viewport
          await segmentationService.addSegmentationRepresentation(viewportId, {
            segmentationId,
            type: SegmentationRepresentations.Labelmap,
          });
          console.log('Added Labelmap representation to viewport:', viewportId);
        }

        // Set as active segmentation
        segmentationService.setActiveSegmentation(viewportId, segmentationId);
        console.log('Set active segmentation:', segmentationId, 'for viewport:', viewportId);
      } catch (error) {
        console.error('Error applying segmentation to viewport:', error);
        uiNotificationService.show({
          title: 'Apply Failed',
          message: `Failed to apply segmentation to viewport: ${error.message}`,
          type: 'error',
          duration: 5000,
        });
        throw error;
      }
    },

    /**
     * Main function: Run server-side segmentation and update viewport
     * Handles both Scenario A (unsaved) and Scenario B (saved) segmentations
     *
     * @param params - Parameters
     * @param params.viewportId - Optional viewport ID (uses active if not provided)
     * @param params.servicesManager - Services manager (already available in closure, but for consistency)
     * @param params.extensionManager - Extension manager (already available in closure, but for consistency)
     * @param params.serverApi - Server API configuration with endpoint and optional params
     * @param params.studyInstanceUID - Study Instance UID (required)
     * @param params.sourceSeriesInstanceUID - Source series to segment (required)
     * @param params.dataSource - Optional dataSource
     * @returns Promise resolving to object with segmentationId and segmentationSeriesInstanceUID
     */
    runServerSegmentationAndUpdateViewport: async ({
      viewportId,
      servicesManager: _servicesManager,
      extensionManager: _extensionManager,
      serverApi,
      studyInstanceUID,
      sourceSeriesInstanceUID,
      dataSource,
    }) => {
      const { uiNotificationService, uiDialogService } =
        servicesManager.services as AppTypes.Services;

      try {
        // Step 1: Get target viewport
        const { activeViewportId } = viewportGridService.getState();
        const targetViewportId = viewportId || activeViewportId;

        if (!targetViewportId) {
          throw new Error('No active viewport found');
        }

        const viewport = getTargetViewport({ viewportId: targetViewportId, viewportGridService });
        if (!viewport) {
          throw new Error(`Viewport not found: ${targetViewportId}`);
        }

        // Step 2: Get active segmentation for viewport
        const activeSegmentation = segmentationService.getActiveSegmentation(targetViewportId);
        if (!activeSegmentation) {
          uiNotificationService.show({
            title: 'No Active Segmentation',
            message: 'Please select or create a segmentation first',
            type: 'warning',
            duration: 5000,
          });
          throw new Error('No active segmentation found in viewport');
        }

        const activeSegmentationId = activeSegmentation.segmentationId;

        // Step 3: Determine scenario (A or B)
        const { isSaved, seriesInstanceUID: existingSegSeriesUID } = actions.isSegmentationSaved({
          segmentationId: activeSegmentationId,
        });

        console.log('Server segmentation scenario:', isSaved ? 'B (saved)' : 'A (unsaved)');

        // For Scenario A, check if segmentation is empty (based on segments, not volume cache)
        let segmentationSeriesInstanceUID: string | undefined;
        if (!isSaved) {
          const segmentation = segmentationService.getSegmentation(activeSegmentationId);
          const hasSegments =
            segmentation?.segments && Object.keys(segmentation.segments).length > 0;

          if (!hasSegments) {
            // Empty unsaved segmentation - call server without segmentationSeriesInstanceUID
            segmentationSeriesInstanceUID = undefined;
          } else {
            // Non-empty unsaved - should have been saved first
            // But for server call, we'll proceed without it (server will create new)
            segmentationSeriesInstanceUID = undefined;
          }
        } else {
          // Scenario B: Use existing SeriesInstanceUID
          segmentationSeriesInstanceUID = existingSegSeriesUID;
        }

        // Step 4: Call server segmentation endpoint
        uiNotificationService.show({
          title: 'Processing',
          message: 'Running server-side segmentation...',
          type: 'info',
          duration: 3000,
        });

        const returnedSegSeriesUID = await actions.runServerSegmentation({
          studyInstanceUID,
          sourceSeriesInstanceUID,
          segmentationSeriesInstanceUID,
          serverApi,
          dataSource,
        });

        // Step 5: Load/reload SEG displaySet from DICOMweb
        const segDisplaySet = await actions.loadOrReloadSegDisplaySet({
          studyInstanceUID,
          segSeriesInstanceUID: returnedSegSeriesUID,
          dataSource,
        });

        // Step 6: Handle duplicate segmentations
        // Remove old representation before loading new one to avoid duplicates
        const existingReps = segmentationService.getSegmentationRepresentations(targetViewportId);
        const oldRep = existingReps.find(
          rep =>
            rep.segmentationId === activeSegmentationId &&
            rep.type === SegmentationRepresentations.Labelmap
        );

        if (oldRep) {
          // Remove old representation before adding new one
          segmentationService.removeSegmentationRepresentations(targetViewportId, {
            segmentationId: activeSegmentationId,
            type: SegmentationRepresentations.Labelmap,
          });
          console.log('Removed old segmentation representation to avoid duplicates');
        }

        // Step 7: Hydrate segmentation from displaySet
        // For Scenario B: use existing segmentationId to update in-place
        // For Scenario A: let it create new segmentation using displaySetInstanceUID
        const hydratedSegmentationId = await actions.hydrateSegmentationFromDisplaySet({
          segDisplaySet,
          viewportId: targetViewportId,
          segmentationId: isSaved ? activeSegmentationId : undefined, // Scenario B: update in-place
        });

        // Step 8: Apply segmentation to viewport (ensure Labelmap rep and set active)
        await actions.applySegmentationToViewport({
          viewportId: targetViewportId,
          segmentationId: hydratedSegmentationId,
        });

        // Step 9: Success notification
        uiNotificationService.show({
          title: 'Success',
          message: 'Server segmentation completed and loaded',
          type: 'success',
          duration: 3000,
        });

        console.log('Server segmentation flow completed successfully:', {
          scenario: isSaved ? 'B' : 'A',
          segmentationId: hydratedSegmentationId,
          segmentationSeriesInstanceUID: returnedSegSeriesUID,
        });

        return {
          segmentationId: hydratedSegmentationId,
          segmentationSeriesInstanceUID: returnedSegSeriesUID,
        };
      } catch (error) {
        console.error('Error in runServerSegmentationAndUpdateViewport:', error);

        if (error instanceof UserCancelledError) {
          return null;
        }

        uiNotificationService.show({
          title: 'Server Segmentation Failed',
          message: error.message || 'An error occurred during server-side segmentation',
          type: 'error',
          duration: 5000,
        });

        throw error;
      }
    },
  };

  const definitions = {
    loadSegmentationsForViewport: actions.loadSegmentationsForViewport,
    generateSegmentation: actions.generateSegmentation,
    downloadSegmentation: actions.downloadSegmentation,
    storeSegmentation: actions.storeSegmentation,
    downloadRTSS: actions.downloadRTSS,
    toggleActiveSegmentationUtility: actions.toggleActiveSegmentationUtility,
    sendToGlasses: actions.sendToGlasses,
    downloadObj: actions.downloadObj,
    segmentByPreset: actions.segmentByPreset,
    magicWandSegmentation: actions.magicWandSegmentation,
    // Server-side segmentation helpers
    isSegmentationSaved: actions.isSegmentationSaved,
    runServerSegmentation: actions.runServerSegmentation,
    loadOrReloadSegDisplaySet: actions.loadOrReloadSegDisplaySet,
    hydrateSegmentationFromDisplaySet: actions.hydrateSegmentationFromDisplaySet,
    applySegmentationToViewport: actions.applySegmentationToViewport,
    // Main server-side segmentation function
    runServerSegmentationAndUpdateViewport: actions.runServerSegmentationAndUpdateViewport,
  };

  return {
    actions,
    definitions,
    defaultContext: 'SEGMENTATION',
  };
};

export default commandsModule;
