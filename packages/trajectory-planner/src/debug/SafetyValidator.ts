/**
 * SafetyValidator — post-hoc sanity checks on an optimization result.
 *
 * Validates invariants that MUST hold after every planner run:
 *   1. Dilation was never applied to the hematoma mask.
 *   2. No selected trajectory intersects dilated obstacle masks.
 *   3. All normalised score terms are finite and in expected range.
 *
 * Returns a list of violations.  An empty list means the result is
 * safe.  These checks are cheap and should be run on every result.
 */

import type {
  VoxelMasks,
  ScoredTrajectory,
  ScoreBreakdown,
} from '../types';
import { violatesHardConstraints } from '../planner/TrajectoryEvaluator';

// ─── types ──────────────────────────────────────────────────────────

export type ViolationSeverity = 'error' | 'warning';

export interface Violation {
  severity: ViolationSeverity;
  code: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  violations: Violation[];
}

// ─── checks ─────────────────────────────────────────────────────────

function checkDilationNotOnHematoma(
  baseMasks: VoxelMasks,
  dilatedMasks: VoxelMasks | undefined,
  out: Violation[],
): void {
  if (!dilatedMasks) return;

  // The dilated set must share the SAME hematomaMask instance (or
  // identical data) as the base set — it should never be enlarged.
  if (dilatedMasks.hematomaMask !== baseMasks.hematomaMask) {
    // Deep equality check: same dims, same data bytes
    const a = baseMasks.hematomaMask;
    const b = dilatedMasks.hematomaMask;
    const dimsMatch =
      a.dims[0] === b.dims[0] &&
      a.dims[1] === b.dims[1] &&
      a.dims[2] === b.dims[2];
    let dataMatch = dimsMatch;
    if (dimsMatch) {
      for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== b.data[i]) { dataMatch = false; break; }
      }
    }
    if (!dataMatch) {
      out.push({
        severity: 'error',
        code: 'DILATION_ON_HEMATOMA',
        message: 'Dilated mask set contains a modified hematoma mask. Dilation must only be applied to obstacle masks.',
      });
    }
  }
}

function checkTrajectoryVsDilatedMasks(
  trajectories: ScoredTrajectory[],
  baseMasks: VoxelMasks,
  dilatedMasks: VoxelMasks | undefined,
  out: Violation[],
): void {
  const effectiveMasks = dilatedMasks ?? baseMasks;

  for (let i = 0; i < trajectories.length; i++) {
    const t = trajectories[i];
    if (violatesHardConstraints(t, baseMasks, dilatedMasks)) {
      out.push({
        severity: 'error',
        code: 'SELECTED_VIOLATES_DILATED',
        message: `Trajectory rank ${i} intersects a dilated obstacle mask. Hard constraint violated post-selection.`,
      });
    }
  }
}

function checkScoreBreakdownRanges(
  trajectories: ScoredTrajectory[],
  out: Violation[],
): void {
  for (let i = 0; i < trajectories.length; i++) {
    const b: ScoreBreakdown = trajectories[i].scoreBreakdown;
    const tag = `rank ${i}`;

    if (!Number.isFinite(b.vhNorm)) {
      out.push({ severity: 'error', code: 'VH_NORM_NOT_FINITE', message: `${tag}: vhNorm is not finite (${b.vhNorm})` });
    } else if (b.vhNorm < -1e-9 || b.vhNorm > 1 + 1e-9) {
      out.push({ severity: 'warning', code: 'VH_NORM_OUT_OF_RANGE', message: `${tag}: vhNorm=${b.vhNorm.toFixed(6)} outside [0,1]` });
    }

    if (!Number.isFinite(b.dSkinNorm)) {
      out.push({ severity: 'error', code: 'DSKIN_NORM_NOT_FINITE', message: `${tag}: dSkinNorm is not finite (${b.dSkinNorm})` });
    } else if (b.dSkinNorm < -1e-9 || b.dSkinNorm > 1 + 1e-9) {
      out.push({ severity: 'warning', code: 'DSKIN_NORM_OUT_OF_RANGE', message: `${tag}: dSkinNorm=${b.dSkinNorm.toFixed(6)} outside [0,1]` });
    }

    if (!Number.isFinite(b.lengthNorm)) {
      out.push({ severity: 'error', code: 'LENGTH_NORM_NOT_FINITE', message: `${tag}: lengthNorm is not finite (${b.lengthNorm})` });
    } else if (b.lengthNorm < -1e-9 || b.lengthNorm > 1 + 1e-9) {
      out.push({ severity: 'warning', code: 'LENGTH_NORM_OUT_OF_RANGE', message: `${tag}: lengthNorm=${b.lengthNorm.toFixed(6)} outside [0,1]` });
    }

    if (!Number.isFinite(b.proximityNorm)) {
      out.push({ severity: 'error', code: 'PROX_NORM_NOT_FINITE', message: `${tag}: proximityNorm is not finite (${b.proximityNorm})` });
    } else if (b.proximityNorm < -1e-9 || b.proximityNorm > 1 + 1e-9) {
      out.push({ severity: 'warning', code: 'PROX_NORM_OUT_OF_RANGE', message: `${tag}: proximityNorm=${b.proximityNorm.toFixed(6)} outside [0,1)` });
    }

    if (!Number.isFinite(trajectories[i].score)) {
      out.push({ severity: 'error', code: 'SCORE_NOT_FINITE', message: `${tag}: final score is not finite` });
    }

    // Margin distances should be non-negative
    for (const [key, val] of [['dVessel', b.dVessel], ['dVent', b.dVent], ['dSinus', b.dSinus]] as const) {
      if (Number.isFinite(val) && val < 0) {
        out.push({ severity: 'warning', code: 'NEGATIVE_MARGIN', message: `${tag}: ${key}=${val.toFixed(2)} is negative` });
      }
    }
  }
}

// ─── public API ─────────────────────────────────────────────────────

export interface ValidateInput {
  trajectories: ScoredTrajectory[];
  baseMasks: VoxelMasks;
  dilatedMasks?: VoxelMasks;
}

/**
 * Run all safety sanity checks and return a report.
 * An empty `violations` array means all checks passed.
 */
export function validateSafety(input: ValidateInput): ValidationReport {
  const violations: Violation[] = [];

  checkDilationNotOnHematoma(input.baseMasks, input.dilatedMasks, violations);
  checkTrajectoryVsDilatedMasks(input.trajectories, input.baseMasks, input.dilatedMasks, violations);
  checkScoreBreakdownRanges(input.trajectories, violations);

  return {
    valid: violations.every(v => v.severity !== 'error'),
    violations,
  };
}

/**
 * Format a validation report as a human-readable string.
 */
export function formatValidationReport(report: ValidationReport): string {
  if (report.violations.length === 0) {
    return '✓ All safety checks passed.';
  }
  const lines = [`Safety validation: ${report.valid ? 'WARNINGS' : 'FAILED'}`];
  for (const v of report.violations) {
    lines.push(`  [${v.severity.toUpperCase()}] ${v.code}: ${v.message}`);
  }
  return lines.join('\n');
}
