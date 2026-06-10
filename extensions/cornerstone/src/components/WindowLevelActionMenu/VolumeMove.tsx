import React, { ReactElement, useCallback, useEffect, useState, useRef } from 'react';
import { VolumeMoveProps } from '../../types/ViewportPresets';
import { Numeric } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';

/**
 * "Move" control: spatially translates the volume render together with its
 * segmentation along the camera view direction. Unlike "Shift" (opacity
 * transfer function), this is a real world-space translation applied with the
 * same matrix to all viewport actors, so volume and segmentation stay aligned.
 */
export function VolumeMove({ viewportId }: VolumeMoveProps): ReactElement {
  const { servicesManager, commandsManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const [minMove, setMinMove] = useState<number | null>(null);
  const [maxMove, setMaxMove] = useState<number | null>(null);
  const [move, setMove] = useState<number>(
    cornerstoneViewportService.getCornerstoneViewport(viewportId)?.movedBy || 0
  );
  const [step, setStep] = useState<number | null>(null);

  const prevMoveRef = useRef<number>(move);

  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
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

  const onChangeRange = useCallback(
    newMove => {
      const moveDifference = newMove - prevMoveRef.current;
      prevMoveRef.current = newMove;
      viewport.movedBy = newMove;
      commandsManager.runCommand('moveVolumeWithSegmentation', {
        viewportId,
        move: moveDifference,
      });
      setMove(newMove);
    },
    [commandsManager, viewportId, viewport]
  );

  return (
    <div className="my-1 mt-2 flex flex-col space-y-2">
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
