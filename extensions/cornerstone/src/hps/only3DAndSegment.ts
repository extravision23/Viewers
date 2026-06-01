import { HYDRATE_SEG_SYNC_GROUP } from './mpr';
import i18n from 'i18next';

export const only3DAndSegment = {
  id: 'only3DAndSegment',
  locked: true,
  name: i18n.t('Hps:3D Only + Segment'),
  icon: 'layout-advanced-3d-only',
  isPreset: true,
  createdDate: '2025-06-01T00:00:00.000Z',
  modifiedDate: '2025-06-01T00:00:00.000Z',
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
      id: 'only3DAndSegmentStage',
      name: 'only3DAndSegment',
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
