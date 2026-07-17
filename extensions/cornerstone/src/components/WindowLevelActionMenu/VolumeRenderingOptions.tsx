import React, { ReactElement, useState, useCallback } from 'react';
import { AllInOneMenu } from '@ohif/ui-next';
import { VolumeRenderingQuality } from './VolumeRenderingQuality';
import { VolumeShift } from './VolumeShift';
import { VolumeMove } from './VolumeMove';
import { VolumeLighting } from './VolumeLighting';
import { VolumeShade } from './VolumeShade';
import { VolumeSegmentCutMode } from './VolumeSegmentCutMode';
import { VolumeSurfaceMaterialPreview } from './VolumeSurfaceMaterialPreview';
import { useViewportRendering } from '../../hooks/useViewportRendering';
import { useTranslation } from 'react-i18next';
import { useSystem } from '@ohif/core';

function getInitialShadeFromViewport(
  cornerstoneViewportService: AppTypes.CornerstoneViewportService,
  viewportId?: string
): boolean {
  if (!viewportId) {
    return true;
  }

  try {
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const actor = viewport?.getActors?.()?.[0]?.actor;

    if (actor?.getProperty) {
      return actor.getProperty().getShade() ?? true;
    }
  } catch {
    // Viewport may not be ready on first render
  }

  return true;
}

/** Rendering controls without AllInOneMenu.ItemPanel (for nested menus or floating panel). */
export function VolumeRenderingOptionsContent({
  viewportId,
}: {
  viewportId?: string;
} = {}): ReactElement {
  const { servicesManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const { volumeRenderingQualityRange } = useViewportRendering(viewportId);
  const [hasShade, setShade] = useState(() =>
    getInitialShadeFromViewport(cornerstoneViewportService, viewportId)
  );
  const { t } = useTranslation('WindowLevelActionMenu');

  const handleShadeChange = useCallback((enabled: boolean) => {
    setShade(enabled);
  }, []);

  return (
    <>
      <VolumeRenderingQuality
        viewportId={viewportId}
        volumeRenderingQualityRange={volumeRenderingQualityRange}
      />
      <VolumeShift viewportId={viewportId} />
      <VolumeMove viewportId={viewportId} />
      {viewportId ? (
        <>
          <div className="hover:bg-accent mt-1 flex h-8 w-full flex-shrink-0 items-center px-2 text-base hover:rounded">
            <VolumeSegmentCutMode viewportId={viewportId} />
          </div>
          <div className="hover:bg-accent flex h-8 w-full flex-shrink-0 items-center px-2 text-base hover:rounded">
            <VolumeSurfaceMaterialPreview viewportId={viewportId} />
          </div>
        </>
      ) : null}
      <div className="mt-2 flex h-8 !h-[20px] w-full flex-shrink-0 items-center justify-start px-2 text-base">
        <div className="text-muted-foreground text-sm">{t('Lighting')}</div>
      </div>
      <div className="bg-background mt-1 mb-1 h-px w-full"></div>
      <div className="hover:bg-accent flex h-8 w-full flex-shrink-0 items-center px-2 text-base hover:rounded">
        <VolumeShade
          viewportId={viewportId}
          onClickShade={handleShadeChange}
        />
      </div>
      <VolumeLighting
        viewportId={viewportId}
        hasShade={hasShade}
      />
    </>
  );
}

export function VolumeRenderingOptions({ viewportId }: { viewportId?: string } = {}): ReactElement {
  return (
    <AllInOneMenu.ItemPanel>
      <VolumeRenderingOptionsContent viewportId={viewportId} />
    </AllInOneMenu.ItemPanel>
  );
}
