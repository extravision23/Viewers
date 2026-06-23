import React, { ReactElement, useCallback, useEffect, useState } from 'react';
import { VolumeMoveProps, VolumeCutMode, VolumeCutPlanesState } from '../../types/ViewportPresets';
import { Numeric, Checkbox } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';

const CUT_MODES: VolumeCutMode[] = ['observer', 'coronal', 'sagittal', 'axial'];

function getDefaultState(): VolumeCutPlanesState {
  return {
    observer: { enabled: false, offset: 0 },
    coronal: { enabled: false, offset: 0 },
    sagittal: { enabled: false, offset: 0 },
    axial: { enabled: false, offset: 0 },
  };
}

/**
 * "Move" control: applies clipping planes ("cuts") that slice the volume render
 * together with its segmentation (volume label and segment surfaces). Each mode
 * (observer / coronal / sagittal / axial) can be enabled independently via its
 * checkbox and adjusted with its own slider, so several cuts can be combined at
 * once (e.g. a sagittal and a coronal cut carve out a corner). The same planes
 * are applied to every actor so the volume and its segmentation stay consistent.
 */
export function VolumeMove({ viewportId }: VolumeMoveProps): ReactElement {
  const { servicesManager, commandsManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

  const [minMove, setMinMove] = useState<number | null>(null);
  const [maxMove, setMaxMove] = useState<number | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [planes, setPlanes] = useState<VolumeCutPlanesState>(
    () => viewport?.cutPlanes || getDefaultState()
  );

  const { t } = useTranslation('WindowLevelActionMenu');

  useEffect(() => {
    const { actor } = viewport.getActors()[0] ?? {};
    const imageData = actor?.getMapper?.()?.getInputData?.();
    const bounds = imageData?.getBounds?.();

    let diagonal = 500;
    if (bounds) {
      diagonal =
        Math.hypot(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]) || 500;
    }

    setMinMove(-Math.round(diagonal / 2));
    setMaxMove(Math.round(diagonal / 2));
    setStep(1);
  }, [viewport]);

  const applyPlanes = useCallback(
    (next: VolumeCutPlanesState) => {
      viewport.cutPlanes = next;
      const activePlanes = CUT_MODES.filter(mode => next[mode].enabled).map(mode => ({
        mode,
        offset: next[mode].offset,
      }));
      commandsManager.runCommand('setVolumeCutPlanes', {
        viewportId,
        planes: activePlanes,
      });
    },
    [commandsManager, viewportId, viewport]
  );

  const onToggle = useCallback(
    (mode: VolumeCutMode, enabled: boolean) => {
      setPlanes(prev => {
        const next = { ...prev, [mode]: { ...prev[mode], enabled } };
        applyPlanes(next);
        return next;
      });
    },
    [applyPlanes]
  );

  const onChangeOffset = useCallback(
    (mode: VolumeCutMode, offset: number) => {
      setPlanes(prev => {
        const next = { ...prev, [mode]: { enabled: true, offset } };
        applyPlanes(next);
        return next;
      });
    },
    [applyPlanes]
  );

  return (
    <div className="my-1 mt-2 flex flex-col space-y-2">
      {step !== null &&
        minMove !== null &&
        maxMove !== null &&
        CUT_MODES.map(mode => (
          <div
            key={mode}
            className="flex w-full flex-row items-center pl-2 pr-1"
          >
            <Checkbox
              id={`cut-${mode}-${viewportId}`}
              checked={planes[mode].enabled}
              onCheckedChange={checked => onToggle(mode, checked === true)}
              className="mr-2"
            />
            <Numeric.Container
              mode="singleRange"
              min={minMove}
              max={maxMove}
              step={step}
              value={planes[mode].offset}
              onChange={value => onChangeOffset(mode, value as number)}
              className="flex-grow"
            >
              <div className="flex flex-row items-center">
                <Numeric.Label className="w-16 text-xs">
                  {t(mode.charAt(0).toUpperCase() + mode.slice(1))}
                </Numeric.Label>
                <Numeric.SingleRange sliderClassName="mx-2 flex-grow" />
              </div>
            </Numeric.Container>
          </div>
        ))}
    </div>
  );
}
