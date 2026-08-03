import React, { ReactElement, useState } from 'react';
import { AllInOneMenu, Icons } from '@ohif/ui-next';
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
  const [collapsed, setCollapsed] = useState(false);

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
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <button
        type="button"
        className="bg-primary-dark/95 border-primary-light text-foreground hover:bg-primary-dark flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm shadow-lg backdrop-blur-sm"
        onClick={() => setCollapsed(prev => !prev)}
        aria-expanded={!collapsed}
        data-cy="volume-rendering-floating-panel-toggle"
        title={collapsed ? t('Expand controls') : t('Collapse controls')}
      >
        <span className="truncate font-medium">{t('Rendering Options')}</span>
        {collapsed ? (
          <Icons.ChevronClosed className="h-5 w-5 shrink-0" />
        ) : (
          <Icons.ChevronOpen className="h-5 w-5 shrink-0" />
        )}
      </button>

      {!collapsed && (
        <div className="mt-1">
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
      )}
    </div>
  );
}
