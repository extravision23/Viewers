/**
 * SensitivitySweep — one-at-a-time parameter sweeps around a
 * baseline config.
 *
 * For each sweep parameter, every other parameter is held at its
 * baseline value while the target parameter walks through a list of
 * test values.  At each point the full BatchEvaluator runs and
 * aggregate metrics are recorded.
 *
 * Sweepable parameters:
 *   alpha, beta, gamma, wVessel, wVent, wSinus,
 *   dilationRadiusMm, coneHalfAngleDeg, samplesPerCone
 */

import type { OptimizerConfig } from '../types';
import { DEFAULT_OPTIMIZER_CONFIG } from '../types';
import { runBatchEvaluation, type EvalCase, type BatchResult } from '../debug/BatchEvaluator';
import { buildTuningReadiness, type TuningReadinessReport } from '../debug/TuningReadinessReport';
import {
  buildExperimentMeta,
  snapshotConfig,
  configFromSnapshot,
  type ExperimentMeta,
  type ConfigSnapshot,
} from './ExperimentMetadata';

// ─── types ──────────────────────────────────────────────────────────

export type SweepParam =
  | 'alpha' | 'beta' | 'gamma'
  | 'wVessel' | 'wVent' | 'wSinus'
  | 'dilationRadiusMm'
  | 'coneHalfAngleDeg' | 'samplesPerCone';

/** Aggregate metrics at one sweep point. */
export interface SweepPointMetrics {
  paramValue: number;
  trajectoryRate: number;
  rejectionRate: number;
  avgIntralesionalFraction: number;
  avgMinVesselMarginMm: number;
  avgMinVentMarginMm: number;
  avgMinSinusMarginMm: number;
  avgAngularDeviationDeg: number | null;
  avgEntryDistanceMm: number | null;
  elapsedMs: number;
}

/** Result of sweeping a single parameter. */
export interface ParamSweepResult {
  param: SweepParam;
  baselineValue: number;
  points: SweepPointMetrics[];
  meta: ExperimentMeta;
}

/** Full sweep result across all requested parameters. */
export interface SweepResult {
  sweeps: ParamSweepResult[];
  /** Pre-built CSV: one file per parameter, one row per sweep value. */
  csvExports: { param: SweepParam; csv: string }[];
}

// ─── config mutation ────────────────────────────────────────────────

function setParam(snap: ConfigSnapshot, param: SweepParam, value: number): ConfigSnapshot {
  const out = { ...snap };
  switch (param) {
    case 'alpha': out.alpha = value; break;
    case 'beta': out.beta = value; break;
    case 'gamma': out.gamma = value; break;
    case 'wVessel': out.wVessel = value; break;
    case 'wVent': out.wVent = value; break;
    case 'wSinus': out.wSinus = value; break;
    case 'dilationRadiusMm': out.dilationRadiusMm = value; break;
    case 'coneHalfAngleDeg': out.coneHalfAngleDeg = value; break;
    case 'samplesPerCone': out.samplesPerCone = value; break;
  }
  return out;
}

function getParam(snap: ConfigSnapshot, param: SweepParam): number {
  switch (param) {
    case 'alpha': return snap.alpha;
    case 'beta': return snap.beta;
    case 'gamma': return snap.gamma;
    case 'wVessel': return snap.wVessel;
    case 'wVent': return snap.wVent;
    case 'wSinus': return snap.wSinus;
    case 'dilationRadiusMm': return snap.dilationRadiusMm;
    case 'coneHalfAngleDeg': return snap.coneHalfAngleDeg;
    case 'samplesPerCone': return snap.samplesPerCone;
  }
}

// ─── metric extraction ──────────────────────────────────────────────

function extractPointMetrics(
  value: number,
  batch: BatchResult,
  readiness: TuningReadinessReport,
): SweepPointMetrics {
  return {
    paramValue: value,
    trajectoryRate: batch.summary.totalCases > 0
      ? batch.summary.casesWithTrajectory / batch.summary.totalCases
      : 0,
    rejectionRate: readiness.avgRejectionRate,
    avgIntralesionalFraction: readiness.avgIntralesionalFraction,
    avgMinVesselMarginMm: readiness.avgMinVesselMarginMm,
    avgMinVentMarginMm: readiness.avgMinVentMarginMm,
    avgMinSinusMarginMm: readiness.avgMinSinusMarginMm,
    avgAngularDeviationDeg: readiness.avgAngularDeviationDeg,
    avgEntryDistanceMm: readiness.avgEntryDistanceMm,
    elapsedMs: batch.summary.totalElapsedMs,
  };
}

// ─── CSV export ─────────────────────────────────────────────────────

const SWEEP_CSV_HEADERS = [
  'paramValue',
  'trajectoryRate',
  'rejectionRate',
  'avgILFraction',
  'avgVesselMargin_mm',
  'avgVentMargin_mm',
  'avgSinusMargin_mm',
  'avgAngularDev_deg',
  'avgEntryDist_mm',
  'elapsedMs',
] as const;

function buildSweepCsv(sweep: ParamSweepResult): string {
  const lines: string[] = [];
  const m = sweep.meta;
  lines.push(`# sweep_param=${sweep.param} baseline=${sweep.baselineValue}`);
  lines.push(`# runId=${m.runId} tag=${m.tag} timestamp=${m.timestamp}`);
  lines.push(SWEEP_CSV_HEADERS.join(','));
  for (const p of sweep.points) {
    lines.push([
      p.paramValue,
      p.trajectoryRate,
      p.rejectionRate,
      p.avgIntralesionalFraction,
      fv(p.avgMinVesselMarginMm),
      fv(p.avgMinVentMarginMm),
      fv(p.avgMinSinusMarginMm),
      fv(p.avgAngularDeviationDeg),
      fv(p.avgEntryDistanceMm),
      p.elapsedMs,
    ].join(','));
  }
  return lines.join('\n');
}

function fv(v: number | null): string {
  if (v === null) return '';
  if (!Number.isFinite(v)) return '';
  return String(v);
}

// ─── public API ─────────────────────────────────────────────────────

export interface SweepParamSpec {
  param: SweepParam;
  values: number[];
}

export interface SweepInput {
  cases: EvalCase[];
  baseConfig?: Partial<OptimizerConfig>;
  sweeps: SweepParamSpec[];
  onSweepPointComplete?: (param: SweepParam, valueIndex: number, totalValues: number) => void;
}

/**
 * Run one-at-a-time sensitivity sweeps and return aggregate metrics
 * at every sweep point.
 *
 * Deterministic: identical inputs always produce identical outputs
 * (apart from wall-clock timestamps and elapsed-ms timing noise).
 */
export function runSensitivitySweeps(input: SweepInput): SweepResult {
  const resolvedBase: OptimizerConfig = {
    ...DEFAULT_OPTIMIZER_CONFIG,
    ...input.baseConfig,
    generator: {
      ...DEFAULT_OPTIMIZER_CONFIG.generator,
      ...input.baseConfig?.generator,
    },
    coefficients: {
      ...DEFAULT_OPTIMIZER_CONFIG.coefficients,
      ...input.baseConfig?.coefficients,
    },
  };

  const baseSnap = snapshotConfig(resolvedBase);
  const caseIds = input.cases.map(c => c.id);
  const sweeps: ParamSweepResult[] = [];

  for (const spec of input.sweeps) {
    const baselineValue = getParam(baseSnap, spec.param);
    const points: SweepPointMetrics[] = [];

    for (let vi = 0; vi < spec.values.length; vi++) {
      const val = spec.values[vi];
      const pointSnap = setParam(baseSnap, spec.param, val);
      const pointConfig = configFromSnapshot(pointSnap);

      const batch = runBatchEvaluation({
        cases: input.cases,
        config: pointConfig,
      });
      const readiness = buildTuningReadiness(batch);
      points.push(extractPointMetrics(val, batch, readiness));
      input.onSweepPointComplete?.(spec.param, vi, spec.values.length);
    }

    const meta = buildExperimentMeta(
      `sweep-${spec.param}`,
      resolvedBase,
      caseIds,
    );

    sweeps.push({ param: spec.param, baselineValue, points, meta });
  }

  const csvExports = sweeps.map(s => ({
    param: s.param,
    csv: buildSweepCsv(s),
  }));

  return { sweeps, csvExports };
}

/**
 * Generate a default set of sweep specs around a baseline config.
 * Produces 5 values per parameter centred on the baseline.
 */
export function defaultSweepSpecs(baseConfig?: Partial<OptimizerConfig>): SweepParamSpec[] {
  const resolved: OptimizerConfig = {
    ...DEFAULT_OPTIMIZER_CONFIG,
    ...baseConfig,
    generator: { ...DEFAULT_OPTIMIZER_CONFIG.generator, ...baseConfig?.generator },
    coefficients: { ...DEFAULT_OPTIMIZER_CONFIG.coefficients, ...baseConfig?.coefficients },
  };
  const snap = snapshotConfig(resolved);

  function around(center: number, count: number, lo: number, hi: number): number[] {
    if (count <= 1) return [center];
    const step = (hi - lo) / (count - 1);
    const vals: number[] = [];
    for (let i = 0; i < count; i++) {
      vals.push(parseFloat((lo + i * step).toFixed(4)));
    }
    return vals;
  }

  return [
    { param: 'alpha', values: around(snap.alpha, 5, Math.max(0.1, snap.alpha * 0.4), snap.alpha * 2.0) },
    { param: 'beta', values: around(snap.beta, 5, Math.max(0.01, snap.beta * 0.3), snap.beta * 3.0) },
    { param: 'gamma', values: around(snap.gamma, 5, Math.max(0.05, snap.gamma * 0.3), snap.gamma * 3.0) },
    { param: 'wVessel', values: around(snap.wVessel, 5, Math.max(0.1, snap.wVessel * 0.3), snap.wVessel * 3.0) },
    { param: 'wVent', values: around(snap.wVent, 5, Math.max(0.1, snap.wVent * 0.3), snap.wVent * 3.0) },
    { param: 'wSinus', values: around(snap.wSinus, 5, Math.max(0.1, snap.wSinus * 0.3), snap.wSinus * 3.0) },
    { param: 'dilationRadiusMm', values: [0, 0.5, 1.0, 1.5, 2.0] },
    { param: 'coneHalfAngleDeg', values: [10, 15, 20, 25, 30] },
    { param: 'samplesPerCone', values: [100, 200, 300, 400, 600] },
  ];
}
