import { HYDRATE_SEG_SYNC_GROUP } from './mpr';
import i18n from 'i18next';

export const segment3D = {
  id: 'segment3D',
  locked: true,
  name: i18n.t('Hps:3D Segment'),
  icon: 'tab-segmentation',
  isPreset: true,
  createdDate: '2024-01-01T00:00:00.000Z',
  modifiedDate: '2024-01-01T00:00:00.000Z',
  availableTo: {},
  editableBy: {},
  protocolMatchingRules: [],
  imageLoadStrategy: 'interleaveCenter',
  displaySetSelectors: {
    activeDisplaySet: {
      seriesMatchingRules: [
        {
          weight: 1,
          attribute: 'isReconstructable',
          constraint: {
            equals: {
              value: true,
            },
          },
          required: true,
        },
      ],
    },
  },
  stages: [
    {
      id: 'segment3DStage',
      name: 'segment3D',
      viewportStructure: {
        layoutType: 'grid',
        properties: {
          rows: 1,
          columns: 1,
        },
      },
      viewports: [
        {
          viewportOptions: {
            toolGroupId: 'volume3d',
            viewportType: 'volume3d',
            orientation: 'coronal',
            customViewportProps: {
              hideOverlays: true,
              syncGroups: [HYDRATE_SEG_SYNC_GROUP],
              // Force Surface representation for segmentations in this viewport
              useSurfaceRepresentation: true,
              // Hide volume to show only segments
              hideVolume: true,
            },
          },
          displaySets: [
            {
              id: 'activeDisplaySet',
              options: {
                displayPreset: {
                  CT: 'CT-Bone',
                  MR: 'MR-Default',
                  default: 'CT-Bone',
                },
              },
            },
          ],
        },
      ],
    },
  ],
};
