import React, { ReactElement, useCallback, useState } from 'react';
import { Switch } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';
import { isSurfaceMaterialPreviewColorsEnabled } from '../../utils/surfaceSegmentMaterials';

/**
 * Replaces rainbow segment LUT colors with neutral material tones so Phong /
 * GLSL differences (brain wet, CSF glass, vessel red, bone matte) are easier
 * to judge visually.
 */
export function VolumeSurfaceMaterialPreview({
  viewportId,
}: {
  viewportId: string;
}): ReactElement {
  const { t } = useTranslation('WindowLevelActionMenu');
  const { servicesManager, commandsManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;

  const [enabled, setEnabled] = useState(() => {
    try {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      return viewport ? isSurfaceMaterialPreviewColorsEnabled(viewport) : false;
    } catch {
      return false;
    }
  });

  const onChange = useCallback(
    (checked: boolean) => {
      setEnabled(checked);
      commandsManager.runCommand('setSurfaceMaterialPreviewColors', {
        viewportId,
        enabled: checked,
      });
    },
    [commandsManager, viewportId]
  );

  return (
    <>
      <span className="flex-grow">{t('Material preview')}</span>
      <Switch
        className="ml-2 flex-shrink-0"
        checked={enabled}
        onCheckedChange={onChange}
      />
    </>
  );
}
