/**
 * LossFunction — weighted comparison loss between AI and expert.
 *
 * Loss =
 *   λ1 * angularDeviation
 * + λ2 * entryDistance
 * + λ3 * targetDistance
 * + λ4 * max(0, vessel_exp - vessel_alg)
 * + λ5 * max(0, vent_exp   - vent_alg  )
 * + λ6 * max(0, sinus_exp  - sinus_alg )
 * + λ7 * |V_H_exp - V_H_alg|
 *
 * Margin penalty terms are one-sided: only penalise when the
 * algorithm trajectory is *closer* to a structure than the expert.
 */

import type { ComparisonMetrics } from '../types';

export interface LossWeights {
  lambda1: number; // angular deviation
  lambda2: number; // entry distance
  lambda3: number; // target distance
  lambda4: number; // vessel margin loss (one-sided)
  lambda5: number; // ventricle margin loss (one-sided)
  lambda6: number; // sinus margin loss (one-sided)
  lambda7: number; // intralesional length diff (absolute)
}

export const DEFAULT_LOSS_WEIGHTS: LossWeights = {
  lambda1: 1.0,
  lambda2: 0.5,
  lambda3: 0.5,
  lambda4: 2.0,
  lambda5: 1.5,
  lambda6: 1.0,
  lambda7: 0.3,
};

/**
 * Compute the scalar loss for a single case.
 *
 * NOTE on margin diffs: ComparisonMetrics stores
 *   vesselMarginDiff = margin_alg - margin_exp
 * So negative diff → algorithm is closer → penalise.
 */
export function computeLoss(
  metrics: ComparisonMetrics,
  weights: LossWeights = DEFAULT_LOSS_WEIGHTS,
): number {
  return (
    weights.lambda1 * metrics.angularDeviation +
    weights.lambda2 * metrics.entryDistance +
    weights.lambda3 * metrics.targetDistance +
    weights.lambda4 * Math.max(0, -metrics.vesselMarginDiff) +
    weights.lambda5 * Math.max(0, -metrics.ventMarginDiff) +
    weights.lambda6 * Math.max(0, -metrics.sinusMarginDiff) +
    weights.lambda7 * Math.abs(metrics.intralesionalLengthDiff)
  );
}

/**
 * Average loss over multiple cases.
 */
export function averageLoss(
  metricsArray: ComparisonMetrics[],
  weights: LossWeights = DEFAULT_LOSS_WEIGHTS,
): number {
  if (metricsArray.length === 0) return Infinity;
  let sum = 0;
  for (const m of metricsArray) sum += computeLoss(m, weights);
  return sum / metricsArray.length;
}
