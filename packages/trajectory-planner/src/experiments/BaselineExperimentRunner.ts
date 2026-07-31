/**
 * BaselineExperimentRunner — run a fixed planner config on a fixed
 * case list and produce reproducible, exportable outputs.
 *
 * Outputs:
 *   - aggregate JSON    (all cases + metadata + summary)
 *   - aggregate CSV     (one row per case, flat columns)
 *   - per-case JSON     (individual case results)
 *
 * Every export embeds the full ExperimentMeta header so results can
 * be traced back to an exact configuration.
 */

import type { OptimizerConfig } from '../types';
import { DEFAULT_OPTIMIZER_CONFIG } from '../types';
import { runBatchEvaluation, type EvalCase, type CaseResult, type BatchResult } from '../debug/BatchEvaluator';
import { buildTuningReadiness, type TuningReadinessReport } from '../debug/TuningReadinessReport';
import { buildExperimentMeta, type ExperimentMeta } from './ExperimentMetadata';

// ─── types ──────────────────────────────────────────────────────────

export interface BaselineInput {
  /** Human-readable experiment tag (e.g. "baseline-v1"). */
  tag?: string;
  cases: EvalCase[];
  config?: Partial<OptimizerConfig>;
  onCaseComplete?: (caseResult: CaseResult, index: number, total: number) => void;
}

export interface BaselineExperimentResult {
  meta: ExperimentMeta;
  batch: BatchResult;
  readiness: TuningReadinessReport;

  /** Pre-built exportable artefacts. */
  exports: {
    aggregateJson: string;
    aggregateCsv: string;
    perCaseJsons: { caseId: string; json: string }[];
  };
}

// ─── JSON-safe replacer ─────────────────────────────────────────────

function jsonSafe(_key: string, value: unknown): unknown {
  if (value === Infinity || value === -Infinity) return null;
  if (typeof value === 'number' && Number.isNaN(value)) return null;
  return value;
}

// ─── CSV builder ────────────────────────────────────────────────────

const CSV_HEADERS = [
  'caseId',
  'trajectoryFound',
  'score',
  'vhNorm',
  'dSkinNorm',
  'proximityNorm',
  'dSkinRaw_mm',
  'dVessel_mm',
  'dVent_mm',
  'dSinus_mm',
  'lengthMm',
  'generated',
  'passedHard',
  'scored',
  'rejectionRate',
  'hematomaVol_mm3',
  'elapsedMs',
  'angularDev_deg',
  'entryDist_mm',
  'targetDist_mm',
  'ilLengthDiff_mm',
  'safetyValid',
] as const;

function csvVal(v: number | boolean | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return v.includes(',') ? `"${v}"` : v;
  if (!Number.isFinite(v)) return '';
  return String(v);
}

function buildAggregateCsv(
  meta: ExperimentMeta,
  cases: CaseResult[],
): string {
  const lines: string[] = [];

  // Header comment block with config
  lines.push(`# runId=${meta.runId}`);
  lines.push(`# tag=${meta.tag}`);
  lines.push(`# timestamp=${meta.timestamp}`);
  const cfg = meta.config;
  lines.push(`# alpha=${cfg.alpha} beta=${cfg.beta} gamma=${cfg.gamma} delta=${(cfg as { delta?: number }).delta ?? ''} wVessel=${cfg.wVessel} wVent=${cfg.wVent} wSinus=${cfg.wSinus}`);
  lines.push(`# dilationMm=${cfg.dilationRadiusMm} cone=${cfg.coneHalfAngleDeg}deg samples=${cfg.samplesPerCone} topK=${cfg.topK} spacing=${cfg.spacingMm}mm`);

  lines.push(CSV_HEADERS.join(','));

  for (const c of cases) {
    const s = c.selectedTrajectory;
    const m = c.metricsVsExpert;
    const gen = c.pipeline.generated;
    const rr = gen > 0
      ? (gen - c.pipeline.passedHardConstraints) / gen
      : 0;

    const row = [
      csvVal(c.caseId),
      csvVal(s !== null),
      csvVal(s?.score ?? null),
      csvVal(s?.breakdown.vhNorm ?? null),
      csvVal(s?.breakdown.dSkinNorm ?? null),
      csvVal(s?.breakdown.proximityNorm ?? null),
      csvVal(s?.breakdown.dSkinRaw ?? null),
      csvVal(s?.breakdown.dVessel ?? null),
      csvVal(s?.breakdown.dVent ?? null),
      csvVal(s?.breakdown.dSinus ?? null),
      csvVal(s?.lengthMm ?? null),
      csvVal(c.pipeline.generated),
      csvVal(c.pipeline.passedHardConstraints),
      csvVal(c.pipeline.scored),
      csvVal(rr),
      csvVal(c.maskStats.hematoma.estimatedVolumeMm3),
      csvVal(c.pipeline.elapsedMs),
      csvVal(m?.angularDeviation ?? null),
      csvVal(m?.entryDistance ?? null),
      csvVal(m?.targetDistance ?? null),
      csvVal(m?.intralesionalLengthDiff ?? null),
      csvVal(c.safety.valid),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

// ─── per-case JSON builder ──────────────────────────────────────────

function buildPerCaseJson(
  meta: ExperimentMeta,
  caseResult: CaseResult,
): string {
  return JSON.stringify({ meta, case: caseResult }, jsonSafe, 2);
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Run a baseline experiment: fixed config × fixed case list.
 * Returns the batch result, readiness report, and pre-built export
 * artefacts (aggregate JSON, aggregate CSV, per-case JSONs).
 */
export function runBaselineExperiment(input: BaselineInput): BaselineExperimentResult {
  const resolvedConfig: OptimizerConfig = {
    ...DEFAULT_OPTIMIZER_CONFIG,
    ...input.config,
    generator: {
      ...DEFAULT_OPTIMIZER_CONFIG.generator,
      ...input.config?.generator,
    },
    coefficients: {
      ...DEFAULT_OPTIMIZER_CONFIG.coefficients,
      ...input.config?.coefficients,
    },
  };

  const caseIds = input.cases.map(c => c.id);
  const meta = buildExperimentMeta(
    input.tag ?? 'baseline',
    resolvedConfig,
    caseIds,
  );

  const batch = runBatchEvaluation({
    cases: input.cases,
    config: resolvedConfig,
    onCaseComplete: input.onCaseComplete,
  });

  const readiness = buildTuningReadiness(batch);

  // Build export artefacts
  const aggregateJson = JSON.stringify(
    { meta, batch, readiness },
    jsonSafe,
    2,
  );

  const aggregateCsv = buildAggregateCsv(meta, batch.cases);

  const perCaseJsons = batch.cases.map(c => ({
    caseId: c.caseId,
    json: buildPerCaseJson(meta, c),
  }));

  return {
    meta,
    batch,
    readiness,
    exports: { aggregateJson, aggregateCsv, perCaseJsons },
  };
}
