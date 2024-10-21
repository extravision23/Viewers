import React from 'react';

import { useAppConfig } from '@state';
import { Button, Toolbox } from "@ohif/ui-next";
import PanelSegmentation from './panels/PanelSegmentation';
import classnames from "classnames";
import { ButtonEnums } from '@ohif/ui';

const getPanelModule = ({ commandsManager, servicesManager, extensionManager }: withAppTypes) => {
  const { customizationService } = servicesManager.services;

  const wrappedPanelSegmentation = ({ configuration }) => {
    const [appConfig] = useAppConfig();

    return (
      <PanelSegmentation
        commandsManager={commandsManager}
        servicesManager={servicesManager}
        extensionManager={extensionManager}
        configuration={{
          ...configuration,
          disableEditing: appConfig.disableEditing,
          ...customizationService.get('segmentation.panel'),
        }}
      />
    );
  };

  const wrappedPanelSegmentationWithTools = ({ configuration }) => {
    const [appConfig] = useAppConfig();

    return (
      <>
        <Toolbox
          commandsManager={commandsManager}
          servicesManager={servicesManager}
          extensionManager={extensionManager}
          buttonSectionId="segmentationToolbox"
          title="Segmentation Tools"
          configuration={{
            ...configuration,
          }}
        />
        <PanelSegmentation
          commandsManager={commandsManager}
          servicesManager={servicesManager}
          extensionManager={extensionManager}
          configuration={{
            ...configuration,
            disableEditing: appConfig.disableEditing,
            ...customizationService.get('segmentation.panel'),
          }}
        />
        <Button
          type={ButtonEnums.type.primary}
          className={classnames('ml-2', 'mar-top')}
          onClick={() => {
          }}
        >
          Export to Smart Glasses
        </Button>
      </>
    );
  };

  return [
    {
      name: 'panelSegmentation',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation',
      component: wrappedPanelSegmentation,
    },
    {
      name: 'panelSegmentationWithTools',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation',
      component: wrappedPanelSegmentationWithTools,
    },
  ];
};

export default getPanelModule;
