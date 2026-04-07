import { measurementTrackingMode } from '../contexts/TrackedMeasurementsContext/promptBeginTracking';
const HYDRATE_RESPONSE = {
  CANCEL: 0,
  HYDRATE: 5,
} as const;

function promptSegmentationHydration({
  servicesManager,
  viewportId,
  modality,
}: {
  servicesManager: AppTypes.ServicesManager;
  viewportId: string;
  modality: string;
}) {
  const { uiViewportDialogService, customizationService } = servicesManager.services;
  const appConfig = servicesManager?._extensionManager?._appConfig;

  if (appConfig?.disableConfirmationPrompts) {
    return Promise.resolve(true);
  }

  const messageKey =
    modality === 'RTSTRUCT'
      ? 'viewportNotification.hydrateRTMessage'
      : 'viewportNotification.hydrateSEGMessage';
  const message =
    customizationService.getCustomization(messageKey) || 'Do you want to open this Segmentation?';

  return new Promise<boolean>(resolve => {
    const onSubmit = result => {
      uiViewportDialogService.hide();
      resolve(result === HYDRATE_RESPONSE.HYDRATE);
    };

    uiViewportDialogService.show({
      id: modality === 'RTSTRUCT' ? 'promptHydrateRT' : 'promptHydrateSEG',
      viewportId,
      type: 'info',
      message,
      actions: [
        {
          id: 'no-hydrate',
          type: 'secondary',
          text: 'No',
          value: HYDRATE_RESPONSE.CANCEL,
        },
        {
          id: 'yes-hydrate',
          type: 'primary',
          text: 'Yes',
          value: HYDRATE_RESPONSE.HYDRATE,
        },
      ],
      onSubmit,
      onOutsideClick: () => onSubmit(HYDRATE_RESPONSE.CANCEL),
      onKeyPress: event => {
        if (event.key === 'Enter') {
          onSubmit(HYDRATE_RESPONSE.HYDRATE);
        }
      },
    });
  });
}

type CheckHasDirtyAndSimplifiedModeProps = {
  servicesManager: AppTypes.ServicesManager;
  appConfig: AppTypes.Config;
  displaySetInstanceUID: string;
};

const onDoubleClickHandler = {
  callbacks: [
    ({
      activeViewportId,
      servicesManager,
      commandsManager,
      isHangingProtocolLayout,
      appConfig,
    }) =>
      async displaySetInstanceUID => {
        const {
          hangingProtocolService,
          viewportGridService,
          uiNotificationService,
          displaySetService,
        } = servicesManager.services;
        let updatedViewports = [];
        const viewportId = activeViewportId;
        const haveDirtyMeasurementsInSimplifiedMode = checkHasDirtyAndSimplifiedMode({
          servicesManager,
          appConfig,
          displaySetInstanceUID,
        });

        const clickedDisplaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

        // See default studyBrowserCustomization: SEG/RTSTRUCT must hydrate, not hanging-protocol swap.
        if (
          clickedDisplaySet &&
          (clickedDisplaySet.Modality === 'SEG' || clickedDisplaySet.Modality === 'RTSTRUCT')
        ) {
          const currentDisplaySetUIDs =
            viewportGridService.getDisplaySetsUIDsForViewport(viewportId) || [];
          const currentPrimary = currentDisplaySetUIDs[0];
          if (currentPrimary) {
            (clickedDisplaySet as any).targetViewportPrimaryDisplaySetInstanceUID = currentPrimary;
          }
          try {
            const shouldHydrate = await promptSegmentationHydration({
              servicesManager,
              viewportId,
              modality: clickedDisplaySet.Modality,
            });

            if (!shouldHydrate) {
              return;
            }

            await commandsManager.runCommand('hydrateSecondaryDisplaySet', {
              displaySet: clickedDisplaySet,
              viewportId,
            });
          } catch (error) {
            console.warn(error);
            uiNotificationService.show({
              title: 'Thumbnail Double Click',
              message: 'The selected display sets could not be added to the viewport.',
              type: 'error',
              duration: 3000,
            });
          }
          return;
        }

        try {
          if (!haveDirtyMeasurementsInSimplifiedMode) {
            updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
              viewportId,
              displaySetInstanceUID,
              isHangingProtocolLayout
            );
            viewportGridService.setDisplaySetsForViewports(updatedViewports);
          }
        } catch (error) {
          console.warn(error);
          uiNotificationService.show({
            title: 'Thumbnail Double Click',
            message: 'The selected display sets could not be added to the viewport.',
            type: 'error',
            duration: 3000,
          });
        }
      },
  ],
};

const customOnDropHandlerCallback = async props => {
  const handled = checkHasDirtyAndSimplifiedMode(props);
  return Promise.resolve({ handled });
};

const checkHasDirtyAndSimplifiedMode = (props: CheckHasDirtyAndSimplifiedModeProps) => {
  const { servicesManager, appConfig, displaySetInstanceUID } = props;
  const simplifiedMode = appConfig.measurementTrackingMode === measurementTrackingMode.SIMPLIFIED;
  const { measurementService, displaySetService } = servicesManager.services;
  const measurements = measurementService.getMeasurements();
  const haveDirtyMeasurements =
    measurements.some(m => m.isDirty) ||
    (measurements.length && measurementService.getIsMeasurementDeletedIndividually());
  const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
  const hasDirtyAndSimplifiedMode =
    displaySet.Modality === 'SR' && simplifiedMode && haveDirtyMeasurements;
  return hasDirtyAndSimplifiedMode;
};

export { onDoubleClickHandler, customOnDropHandlerCallback };
