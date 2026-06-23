import React, { ReactElement, useCallback, useEffect, useState } from 'react';
import { VolumeMoveProps, VolumeCutMode } from '../../types/ViewportPresets';
import { Numeric, ToggleGroup, ToggleGroupItem } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';

const CUT_MODES: VolumeCutMode[] = ['observer', 'coronal', 'sagittal', 'axial'];

/**
 * "Move" control: applies a clipping plane ("cut") that slices the volume render
 * together with its segmentation (volume label and segment surfaces). The mode
 * selector chooses the plane orientation - from the observer or a fixed
 * anatomical projection (coronal, sagittal, axial) - and the slider controls the
 * signed cut depth. The same plane is applied to every actor so the volume and
 * its segmentation are always cut consistently.
 */
export function VolumeMove({ viewportId }: VolumeMoveProps): ReactElement {
  const { servicesManager, commandsManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

  const [minMove, setMinMove] = useState<number | null>(null);
  const [maxMove, setMaxMove] = useState<number | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [mode, setMode] = useState<VolumeCutMode>(viewport?.cutMode || 'observer');
  const [move, setMove] = useState<number>(viewport?.cutOffset || 0);

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

  const applyCut = useCallback(
    (nextMode: VolumeCutMode, nextOffset: number) => {
      viewport.cutMode = nextMode;
      viewport.cutOffset = nextOffset;
      commandsManager.runCommand('setVolumeCutPlane', {
        viewportId,
        mode: nextMode,
        offset: nextOffset,
      });
    },
    [commandsManager, viewportId, viewport]
  );

  const onChangeMode = useCallback(
    (value: string) => {
      if (!value) {
        return;
      }
      const nextMode = value as VolumeCutMode;
      setMode(nextMode);
      applyCut(nextMode, move);
    },
    [applyCut, move]
  );

  const onChangeRange = useCallback(
    newMove => {
      setMove(newMove);
      applyCut(mode, newMove);
    },
    [applyCut, mode]
  );

  return (
    <div className="my-1 mt-2 flex flex-col space-y-2">
      <div className="w-full px-2">
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={onChangeMode}
          className="w-full"
        >
          {CUT_MODES.map(cutMode => (
            <ToggleGroupItem
              key={cutMode}
              value={cutMode}
              aria-label={cutMode}
              className="flex-1 text-xs"
            >
              {t(cutMode.charAt(0).toUpperCase() + cutMode.slice(1))}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {step !== null && minMove !== null && maxMove !== null && (
        <div className="w-full pl-2 pr-1">
          <Numeric.Container
            mode="singleRange"
            min={minMove}
            max={maxMove}
            step={step}
            value={move}
            onChange={onChangeRange}
          >
            <div className="flex flex-row items-center">
              <Numeric.Label className="w-16">{t('Move')}</Numeric.Label>
              <Numeric.SingleRange sliderClassName="mx-2 flex-grow" />
            </div>
          </Numeric.Container>
        </div>
      )}
    </div>
  );
}
