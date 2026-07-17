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
  { value: 'volumetric', label: 'Volumetric' },
];

/**
 * Switch for how segmentations are rendered/cut in the 3D view:
 * - Hollow: GPU clipping, two-sided shell (inside visible at the cut).
 * - Hybrid: GPU clipping + backface culling (default). Open cut; exterior looks solid.
 * - Solid: same as Hybrid (open GPU cut); use Volumetric for a filled cut.
 * - Volumetric: labelmap volume GPU ray-cast; filled cuts, voxelized look.
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
