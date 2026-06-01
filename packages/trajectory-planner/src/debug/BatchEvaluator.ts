/**
 * BatchEvaluator — run the planner on a list of cases, collect
 * structured results, and produce JSON-exportable reports.
 *
 * Each case result contains:
 *   - mask stats
 *   - PCA info
 *   - selected trajectory + score breakdown
 *   - comparison metrics vs expert (when expert trajectory provided)
 *   - safety validation report
 */

import type * as THREE from 'three';
import type {
  TrajectoryCandidate,
  ScoredTrajectory,
  OptimizerConfig,
  ComparisonMetrics,
  DistanceFieldSet,
  ScoreBreakdown,
  MaskStats,
  PCAAnisotropy,
} from '../types';
import type { MeshRole } from '../roles';
import { optimizeTrajectories, type OptimizationResult } from '../planner/TrajectoryOptimizer';
import { computeDistanceField } from '../voxel/Voxelizer';
import { computeMetrics } from '../evaluation/TrajectoryMetrics';
import { buildDebugReport, type PlannerDebugReport } from './PlannerDebugReport';
import { validateSafety, type ValidationReport } from './SafetyValidator';

// ─── types ──────────────────────────────────────────────────────────

/** Input for a single evaluation case. */
export interface EvalCase {
  id: string;
  meshesByRole: Map<MeshRole, THREE.Mesh[]>;
  maxLength: number;
  expertTrajectory?: TrajectoryCandidate;
}

/** JSON-safe result for a single case. */
export interface CaseResult {
  caseId: string;

  maskStats: {
    hematoma: MaskStats;
    vessel: MaskStats | null;
    ventricle: MaskStats | null;
    sinus: MaskStats | null;
    brain: MaskStats | null;
  };

  pca: {
    center: { x: number; y: number; z: number };
    axis: { x: number; y: number; z: number };
    eigenValues: [number, number, number];
    anisotropy: PCAAnisotropy;
  };

  pipeline: {
    generated: number;
    passedHardConstraints: number;
    scored: number;
    elapsedMs: number;
  };

  selectedTrajectory: {
    entry: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    lengthMm: number;
    score: number;
    breakdown: ScoreBreakdown;
    minVesselMarginMm: number;
    minVentMarginMm: number;
    minSinusMarginMm: number;
  } | null;

  metricsVsExpert: ComparisonMetrics | null;

  safety: ValidationReport;
}

/** Full batch result. */
export interface BatchResult {
  cases: CaseResult[];
  summary: BatchSummary;
}

/** Aggregate statistics across all cases. */
export interface BatchSummary {
  totalCases: number;
  casesWithTrajectory: number;
  casesWithExpert: number;
  totalElapsedMs: number;
}

// ─── helpers ────────────────────────────────────────────────────────

function v3(v: { x: number; y: number; z: number }) {
  return { x: v.x, y: v.y, z: v.z };
}

function buildCaseResult(
  c: EvalCase,
  opt: OptimizationResult,
  metrics: ComparisonMetrics | null,
  safety: ValidationReport,
): CaseResult {
  const sel = opt.trajectories.length > 0 ? opt.trajectories[0] : null;

  return {
    caseId: c.id,
    maskStats: opt.maskStats,
    pca: {
      center: v3(opt.pca.center),
      axis: v3(opt.pca.principalAxis),
      eigenValues: opt.pca.eigenValues,
      anisotropy: opt.pca.anisotropy,
    },
    pipeline: {
      generated: opt.stats.generated,
      passedHardConstraints: opt.stats.passedHardConstraints,
      scored: opt.stats.scored,
      elapsedMs: opt.stats.elapsedMs,
    },
    selectedTrajectory: sel
      ? {
          entry: v3(sel.entry),
          direction: v3(sel.direction),
          lengthMm: sel.length,
          score: sel.score,
          breakdown: sel.scoreBreakdown,
          minVesselMarginMm: sel.scoreBreakdown.dVessel,
          minVentMarginMm: sel.scoreBreakdown.dVent,
          minSinusMarginMm: sel.scoreBreakdown.dSinus,
        }
      : null,
    metricsVsExpert: metrics,
    safety,
  };
}

// ─── public API ─────────────────────────────────────────────────────

export interface BatchInput {
  cases: EvalCase[];
  config?: Partial<OptimizerConfig>;
  onCaseComplete?: (caseResult: CaseResult, index: number, total: number) => void;
}

/**
 * Run the planner on every case and return structured, JSON-safe
 * results including per-case metrics, safety validation, and an
 * aggregate summary.
 */
export function runBatchEvaluation(input: BatchInput): BatchResult {
  const results: CaseResult[] = [];
  let totalElapsedMs = 0;
  let casesWithTrajectory = 0;
  let casesWithExpert = 0;

  for (let i = 0; i < input.cases.length; i++) {
    const c = input.cases[i];

    const opt = optimizeTrajectories({
      meshesByRole: c.meshesByRole,
      maxLength: c.maxLength,
      config: input.config,
    });

    totalElapsedMs += opt.stats.elapsedMs;

    // Comparison metrics vs expert
    let metrics: ComparisonMetrics | null = null;
    if (c.expertTrajectory && opt.trajectories.length > 0) {
      casesWithExpert++;

      const distanceFields: DistanceFieldSet = {};
      if (opt.masks.vesselMask) distanceFields.vessel = computeDistanceField(opt.masks.vesselMask);
      if (opt.masks.ventricleMask) distanceFields.ventricle = computeDistanceField(opt.masks.ventricleMask);
      if (opt.masks.sinusMask) distanceFields.sinus = computeDistanceField(opt.masks.sinusMask);

      const sel = opt.trajectories[0];
      metrics = computeMetrics({
        expert: c.expertTrajectory,
        algorithm: { entry: sel.entry, direction: sel.direction, length: sel.length },
        masks: opt.masks,
        distanceFields,
      });
    }

    if (opt.trajectories.length > 0) casesWithTrajectory++;

    const safety = validateSafety({
      trajectories: opt.trajectories,
      baseMasks: opt.masks,
    });

    const caseResult = buildCaseResult(c, opt, metrics, safety);
    results.push(caseResult);
    input.onCaseComplete?.(caseResult, i, input.cases.length);
  }

  return {
    cases: results,
    summary: {
      totalCases: input.cases.length,
      casesWithTrajectory,
      casesWithExpert,
      totalElapsedMs,
    },
  };
}

/**
 * Serialise a BatchResult to a JSON string safe for file export.
 * Handles Infinity → null for JSON compliance.
 */
export function batchResultToJson(result: BatchResult, pretty = true): string {
  return JSON.stringify(result, (_key, value) => {
    if (value === Infinity) return null;
    if (value === -Infinity) return null;
    if (typeof value === 'number' && Number.isNaN(value)) return null;
    return value;
  }, pretty ? 2 : undefined);
}
