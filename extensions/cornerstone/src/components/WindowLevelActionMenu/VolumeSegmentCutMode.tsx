import React, { ReactElement, useCallback, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';
import {
  getSegmentCutRenderMode,
  SegmentCutRenderMode,
} from '../../utils/shiftVolumeAndSegmentation';

const MODES: { value: SegmentCutRenderMode; label: string }[] = [
  { value: 'hollow', label: 'Hollow' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'solid', label: 'Solid' },
];

/**
 * Three-way switch for how segment surfaces are cut in the 3D view:
 * - Hollow: legacy GPU clipping planes, the empty inside of the shell is
 *   visible at the cut. Fastest.
 * - Hybrid: GPU planes while interacting, capped (solid) clip once interaction
 *   pauses.
 * - Solid: capped clip recomputed on every change. Always solid, slowest.
 */
export function VolumeSegmentCutMode({ viewportId }: { viewportId: string }): ReactElement {
  const { t } = useTranslation('WindowLevelActionMenu');
  const { servicesManager, commandsManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;

  const [mode, setMode] = useState<SegmentCutRenderMode>(() => {
    try {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      return viewport ? getSegmentCutRenderMode(viewport) : 'hybrid';
    } catch {
      return 'hybrid';
    }
  });

  const onChange = useCallback(
    (value: string) => {
      if (!value) {
        // Radix emits '' when the active item is clicked again; keep the mode.
        return;
      }
      const nextMode = value as SegmentCutRenderMode;
      setMode(nextMode);
      commandsManager.runCommand('setSegmentCutRenderMode', {
        viewportId,
        mode: nextMode,
      });
    },
    [commandsManager, viewportId]
  );

  return (
    <>
      <span className="flex-grow">{t('Segment cuts')}</span>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={onChange}
        className="ml-2 flex-shrink-0"
      >
        {MODES.map(({ value, label }) => (
          <ToggleGroupItem
            key={value}
            value={value}
            aria-label={label}
            size="sm"
            className="text-primary h-6 px-2 text-xs"
          >
            {t(label)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  );
}
