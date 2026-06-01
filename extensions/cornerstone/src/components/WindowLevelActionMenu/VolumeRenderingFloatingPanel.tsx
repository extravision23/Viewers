import React, { ReactElement } from 'react';
import { AllInOneMenu } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import { useSystem } from '@ohif/core';
import { VolumeRenderingPresets } from './VolumeRenderingPresets';
import { VolumeRenderingOptionsContent } from './VolumeRenderingOptions';
import { useViewportRendering } from '../../hooks/useViewportRendering';

export function VolumeRenderingFloatingPanel({
  viewportId,
}: {
  viewportId: string;
}): ReactElement | null {
  const { servicesManager } = useSystem();
  const { customizationService } = servicesManager.services;
  const { t } = useTranslation('WindowLevelActionMenu');

  const panelConfig = customizationService.getCustomization(
    'cornerstone.volumeRenderingFloatingPanel'
  ) as { enabled?: boolean } | undefined;

  const isEnabled = panelConfig?.enabled !== false;

  const { is3DVolume, volumeRenderingQualityRange } = useViewportRendering(viewportId);

  if (!isEnabled || !is3DVolume || !volumeRenderingQualityRange) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto absolute left-2 top-10 z-[100] w-[min(300px,calc(100%-1rem))]"
      data-cy="volume-rendering-floating-panel"
    >
      <AllInOneMenu.Menu
        isVisible={true}
        preventHideMenu={true}
        align="start"
        side="bottom"
        menuClassName="bg-primary-dark/95 border-primary-light shadow-lg backdrop-blur-sm"
      >
        <AllInOneMenu.ItemPanel maxHeight="min(70vh, 480px)">
          <VolumeRenderingPresets viewportId={viewportId} />
          <div className="text-muted-foreground border-primary-light mx-2 mt-2 border-t pt-2 text-sm">
            {t('Rendering Options')}
          </div>
          <VolumeRenderingOptionsContent viewportId={viewportId} />
        </AllInOneMenu.ItemPanel>
      </AllInOneMenu.Menu>
    </div>
  );
}
