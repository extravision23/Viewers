import { utils } from '@ohif/core';
import i18n from '@ohif/i18n';
import { isMprInFlight } from '../utils/mprDeriveState';
const { formatDate } = utils;
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
    customizationService.getCustomization(messageKey) || i18n.t('Do you want to open this Segmentation?');

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

const isEligibleForMpr = displaySet => {
  if (!displaySet) {
    return false;
  }

  const modality = displaySet.Modality;
  if (modality !== 'CT' && modality !== 'MR') {
    return false;
  }

  const seriesDescription = String(displaySet.SeriesDescription || '').toLowerCase();
  const imageType = Array.isArray(displaySet.ImageType)
    ? displaySet.ImageType.map(v => String(v).toLowerCase())
    : [];

  const isDerived =
    imageType.includes('derived') || seriesDescription.includes('(derived)') || seriesDescription.includes('derived');
  const isMprDerived = isDerived && seriesDescription.includes('mpr');

  return !isMprDerived;
};

export default {
  'studyBrowser.studyMenuItems': [],
  'studyBrowser.thumbnailMenuItems': [
    {
      id: 'tagBrowser',
      label: i18n.t('StudyBrowser:Tag Browser'),
      iconName: 'DicomTagBrowser',
      commands: 'openDICOMTagViewer',
    },
    {
      id: 'addAsLayer',
      label: i18n.t('StudyBrowser:Add as Layer'),
      iconName: 'ViewportViews',
      commands: 'addDisplaySetAsLayer',
    },
    {
      id: 'mprCoronal',
      label: 'MPR Coronal',
      iconName: 'ViewportViews',
      commands: 'mprDerive',
      commandOptions: { plane: 'coronal' },
      selector: ({ servicesManager, displaySetInstanceUID }) => {
        const { displaySetService } = servicesManager.services;
        const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
        if (!isEligibleForMpr(displaySet)) {
          return false;
        }
        return !isMprInFlight(displaySet?.SeriesInstanceUID);
      },
    },
    {
      id: 'mprSagittal',
      label: 'MPR Sagittal',
      iconName: 'ViewportViews',
      commands: 'mprDerive',
      commandOptions: { plane: 'sagittal' },
      selector: ({ servicesManager, displaySetInstanceUID }) => {
        const { displaySetService } = servicesManager.services;
        const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
        if (!isEligibleForMpr(displaySet)) {
          return false;
        }
        return !isMprInFlight(displaySet?.SeriesInstanceUID);
      },
    },
    {
      id: 'deleteSegmentation',
      label: i18n.t('StudyBrowser:Delete'),
      iconName: 'Delete',
      commands: 'deleteSegmentation',
    },
  ],
  'studyBrowser.sortFunctions': [
    {
      label: i18n.t('StudyBrowser:Series Number'),
      sortFunction: (a, b) => {
        return a?.SeriesNumber - b?.SeriesNumber;
      },
    },
    {
      label: i18n.t('StudyBrowser:Series Date'),
      sortFunction: (a, b) => {
        const dateA = new Date(formatDate(a?.SeriesDate));
        const dateB = new Date(formatDate(b?.SeriesDate));
        return dateB.getTime() - dateA.getTime();
      },
    },
  ],
  'studyBrowser.viewPresets': [
    {
      id: 'list',
      iconName: 'ListView',
      selected: false,
    },
    {
      id: 'thumbnails',
      iconName: 'ThumbnailView',
      selected: true,
    },
  ],
  'studyBrowser.studyMode': 'all',
  'studyBrowser.thumbnailDoubleClickCallback': {
    callbacks: [
      ({ activeViewportId, servicesManager, commandsManager, isHangingProtocolLayout }) =>
        async displaySetInstanceUID => {
          const {
            hangingProtocolService,
            uiNotificationService,
            viewportGridService,
            displaySetService,
          } = servicesManager.services;
          let updatedViewports = [];
          const viewportId = activeViewportId;

          const clickedDisplaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

          // Store the series that was active in the target viewport at the moment of
          // double‑click so that segmentation hydration can optionally use it as
          // the cross‑reference target (e.g. SEG created on MR‑fusion but shown on CT).
          const currentDisplaySetUIDs =
            viewportGridService.getDisplaySetsUIDsForViewport(viewportId) || [];
          const currentPrimaryDisplaySetInstanceUID = currentDisplaySetUIDs[0];

          if (currentPrimaryDisplaySetInstanceUID) {
            if (
              clickedDisplaySet &&
              (clickedDisplaySet.Modality === 'SEG' || clickedDisplaySet.Modality === 'RTSTRUCT')
            ) {
              (clickedDisplaySet as any).targetViewportPrimaryDisplaySetInstanceUID =
                currentPrimaryDisplaySetInstanceUID;
            }
          }

          // SEG/RTSTRUCT are overlays: hanging protocol "required" series matchers are for
          // primary volumes (e.g. CT). getViewportsRequireUpdate would throw:
          // "does not satisfy the required seriesMatching criteria for the protocol".
          // Use the same hydration path as server-side segmentation / magic wand.
          if (
            clickedDisplaySet &&
            (clickedDisplaySet.Modality === 'SEG' || clickedDisplaySet.Modality === 'RTSTRUCT')
          ) {
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
                title: i18n.t('StudyBrowser:Thumbnail Double Click'),
                message: i18n.t(
                  'StudyBrowser:The selected display sets could not be added to the viewport.'
                ),
                type: 'error',
                duration: 3000,
              });
            }
            return;
          }

          try {
            updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
              viewportId,
              displaySetInstanceUID,
              isHangingProtocolLayout
            );
          } catch (error) {
            console.warn(error);
            uiNotificationService.show({
              title: i18n.t('StudyBrowser:Thumbnail Double Click'),
              message: i18n.t(
                'StudyBrowser:The selected display sets could not be added to the viewport.'
              ),
              type: 'error',
              duration: 3000,
            });
          }

          commandsManager.run('setDisplaySetsForViewports', {
            viewportsToUpdate: updatedViewports,
          });
        },
    ],
  },
};
