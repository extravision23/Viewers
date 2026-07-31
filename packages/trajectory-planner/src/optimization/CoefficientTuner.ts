/**
 * CoefficientTuner — grid search over scoring coefficients.
 *
 * For each coefficient configuration, runs the full planner on every
 * supplied case, computes the loss vs the expert trajectory, and
 * returns the configuration with the lowest average loss.
 *
 * Fully deterministic: no random sampling anywhere in the pipeline.
 */

import type {
  ScoringCoefficients,
  TrajectoryCandidate,
  OptimizerConfig,
  DistanceFieldSet,
} from '../types';
import { DEFAULT_COEFFICIENTS } from '../types';
import type { MeshRole } from '../roles';
import { optimizeTrajectories } from '../planner/TrajectoryOptimizer';
import { computeMetrics } from '../evaluation/TrajectoryMetrics';
import { averageLoss, type LossWeights, DEFAULT_LOSS_WEIGHTS } from '../evaluation/LossFunction';
import { computeDistanceField } from '../voxel/Voxelizer';

// ─── types ──────────────────────────────────────────────────────────

/** A single clinical case for tuning. */
export interface TuningCase {
  meshesByRole: Map<MeshRole, THREE.Mesh[]>;
  expertTrajectory: TrajectoryCandidate;
  maxLength: number;
}

/** Grid-search ranges for each coefficient. */
export interface CoefficientRange {
  min: number;
  max: number;
  steps: number;
}

export interface TunerConfig {
  alphaRange: CoefficientRange;
  betaRange: CoefficientRange;
  gammaRange: CoefficientRange;
  wVesselRange: CoefficientRange;
  wVentRange: CoefficientRange;
  wSinusRange: CoefficientRange;
  lossWeights?: LossWeights;
  baseConfig?: Partial<OptimizerConfig>;
}

export const DEFAULT_TUNER_CONFIG: TunerConfig = {
  alphaRange: { min: 0.4, max: 1.5, steps: 4 },
  betaRange: { min: 0.4, max: 1.8, steps: 4 },
  gammaRange: { min: 0.2, max: 1.5, steps: 4 },
  wVesselRange: { min: 0.5, max: 2.0, steps: 3 },
  wVentRange: { min: 0.3, max: 1.5, steps: 3 },
  wSinusRange: { min: 0.2, max: 1.2, steps: 3 },
};

export interface TunerResult {
  bestCoefficients: ScoringCoefficients;
  bestLoss: number;
  evaluatedConfigs: number;
  elapsedMs: number;
}

// ─── helpers ────────────────────────────────────────────────────────

function linspace(range: CoefficientRange): number[] {
  const { min, max, steps } = range;
  if (steps <= 1) return [min];
  const arr: number[] = [];
  for (let i = 0; i < steps; i++) {
    arr.push(min + (max - min) * (i / (steps - 1)));
  }
  return arr;
}

// ─── public API ─────────────────────────────────────────────────────

export interface TuneInput {
  cases: TuningCase[];
  config?: Partial<TunerConfig>;
  /** Optional progress callback: (evaluatedSoFar, total) */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Run a deterministic grid search over scoring coefficients and
 * return the configuration that minimises average loss across all
 * supplied clinical cases.
 */
export function tuneCoefficients(input: TuneInput): TunerResult {
  const t0 = performance.now();
  const cfg: TunerConfig = { ...DEFAULT_TUNER_CONFIG, ...input.config };
  const lossWeights = cfg.lossWeights ?? DEFAULT_LOSS_WEIGHTS;
  const baseConfig = cfg.baseConfig ?? {};

  const alphas = linspace(cfg.alphaRange);
  const betas = linspace(cfg.betaRange);
  const gammas = linspace(cfg.gammaRange);
  const wVessels = linspace(cfg.wVesselRange);
  const wVents = linspace(cfg.wVentRange);
  const wSinuses = linspace(cfg.wSinusRange);

  const total = alphas.length * betas.length * gammas.length
    * wVessels.length * wVents.length * wSinuses.length;

  let bestLoss = Infinity;
  let bestCoeff: ScoringCoefficients = {
    alpha: alphas[0],
    beta: betas[0],
    gamma: gammas[0],
    delta: DEFAULT_COEFFICIENTS.delta,
    wVessel: wVessels[0],
    wVent: wVents[0],
    wSinus: wSinuses[0],
  };

  let evaluated = 0;

  for (const alpha of alphas) {
    for (const beta of betas) {
      for (const gamma of gammas) {
        for (const wVessel of wVessels) {
          for (const wVent of wVents) {
            for (const wSinus of wSinuses) {
              const coefficients: ScoringCoefficients = {
                alpha, beta, gamma,
                delta: DEFAULT_COEFFICIENTS.delta,
                wVessel, wVent, wSinus,
              };

              const allMetrics = input.cases.map(tc => {
                const result = optimizeTrajectories({
                  meshesByRole: tc.meshesByRole,
                  maxLength: tc.maxLength,
                  config: { ...baseConfig, coefficients },
                });

                if (result.trajectories.length === 0) return null;

                const best = result.trajectories[0];
                const candidate: TrajectoryCandidate = {
                  entry: best.entry,
                  direction: best.direction,
                  length: best.length,
                };

                const distanceFields: DistanceFieldSet = {};
                if (result.masks.vesselMask)
                  distanceFields.vessel = computeDistanceField(result.masks.vesselMask);
                if (result.masks.ventricleMask)
                  distanceFields.ventricle = computeDistanceField(result.masks.ventricleMask);
                if (result.masks.sinusMask)
                  distanceFields.sinus = computeDistanceField(result.masks.sinusMask);

                return computeMetrics({
                  expert: tc.expertTrajectory,
                  algorithm: candidate,
                  masks: result.masks,
                  distanceFields,
                });
              });

              // Skip configs that couldn't solve all cases
              const validMetrics = allMetrics.filter(m => m !== null);
              if (validMetrics.length < input.cases.length) {
                evaluated++;
                input.onProgress?.(evaluated, total);
                continue;
              }

              const loss = averageLoss(validMetrics, lossWeights);
              if (loss < bestLoss) {
                bestLoss = loss;
                bestCoeff = coefficients;
              }

              evaluated++;
              input.onProgress?.(evaluated, total);
            }
          }
        }
      }
    }
  }

  return {
    bestCoefficients: bestCoeff,
    bestLoss,
    evaluatedConfigs: evaluated,
    elapsedMs: performance.now() - t0,
  };
}
