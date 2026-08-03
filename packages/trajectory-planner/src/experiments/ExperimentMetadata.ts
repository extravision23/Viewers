/**
 * ExperimentMetadata — deterministic run identification and
 * configuration snapshot embedded in every experiment export.
 *
 * Run IDs are derived from a FNV-1a hash of the serialised config +
 * sorted case IDs, guaranteeing that identical inputs always produce
 * the same run ID regardless of wall-clock time.
 */

import type { OptimizerConfig, ScoringCoefficients, GeneratorConfig } from '../types';
import { DEFAULT_COEFFICIENTS, DEFAULT_GRADIENT_CONFIG } from '../types';

// ─── types ──────────────────────────────────────────────────────────

/** Flat, JSON-safe snapshot of the full optimizer config. */
export interface ConfigSnapshot {
  alpha: number;
  beta: number;
  gamma: number;
  wVessel: number;
  wVent: number;
  wSinus: number;
  dilationRadiusMm: number;
  coneHalfAngleDeg: number;
  samplesPerCone: number;
  topK: number;
  spacingMm: number;
}

/** Immutable header written into every experiment export. */
export interface ExperimentMeta {
  /** Deterministic hex ID derived from config + case list. */
  runId: string;
  /** ISO-8601 wall-clock timestamp of when the run started. */
  timestamp: string;
  /** Human-readable tag (e.g. "baseline", "sweep-alpha"). */
  tag: string;
  /** Full config snapshot for reproducibility. */
  config: ConfigSnapshot;
  /** Sorted list of case IDs included in the experiment. */
  caseIds: string[];
}

// ─── deterministic run ID ───────────────────────────────────────────

/**
 * FNV-1a 32-bit hash → 8-char hex string.
 * Deterministic, fast, zero dependencies.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Build a deterministic run ID from config + case IDs. */
export function computeRunId(config: ConfigSnapshot, caseIds: string[]): string {
  const sorted = [...caseIds].sort();
  const payload = JSON.stringify({ config, caseIds: sorted });
  return fnv1a(payload);
}

// ─── factory ────────────────────────────────────────────────────────

/** Extract a flat ConfigSnapshot from a full OptimizerConfig. */
export function snapshotConfig(cfg: OptimizerConfig): ConfigSnapshot {
  return {
    alpha: cfg.coefficients.alpha,
    beta: cfg.coefficients.beta,
    gamma: cfg.coefficients.gamma,
    wVessel: cfg.coefficients.wVessel,
    wVent: cfg.coefficients.wVent,
    wSinus: cfg.coefficients.wSinus,
    dilationRadiusMm: cfg.dilationRadiusMm,
    coneHalfAngleDeg: cfg.generator.coneHalfAngleDeg,
    samplesPerCone: cfg.generator.samplesPerCone,
    topK: cfg.topK,
    spacingMm: cfg.spacing,
  };
}

/**
 * Rebuild a full OptimizerConfig from a ConfigSnapshot.
 * Inverse of `snapshotConfig`.
 */
export function configFromSnapshot(snap: ConfigSnapshot): OptimizerConfig {
  const coefficients: ScoringCoefficients = {
    alpha: snap.alpha,
    beta: snap.beta,
    gamma: snap.gamma,
    delta: DEFAULT_COEFFICIENTS.delta,
    epsilon: DEFAULT_COEFFICIENTS.epsilon,
    wVessel: snap.wVessel,
    wVent: snap.wVent,
    wSinus: snap.wSinus,
  };
  const generator: GeneratorConfig = {
    coneHalfAngleDeg: snap.coneHalfAngleDeg,
    samplesPerCone: snap.samplesPerCone,
  };
  return {
    coefficients,
    generator,
    gradient: { ...DEFAULT_GRADIENT_CONFIG },
    topK: snap.topK,
    spacing: snap.spacingMm,
    dilationRadiusMm: snap.dilationRadiusMm,
  };
}

/**
 * Build experiment metadata for a run.
 */
export function buildExperimentMeta(
  tag: string,
  config: OptimizerConfig,
  caseIds: string[],
): ExperimentMeta {
  const snap = snapshotConfig(config);
  return {
    runId: computeRunId(snap, caseIds),
    timestamp: new Date().toISOString(),
    tag,
    config: snap,
    caseIds: [...caseIds].sort(),
  };
}
