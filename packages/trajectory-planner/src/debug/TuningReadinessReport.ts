/**
 * TuningReadinessReport — aggregate statistics across a batch of
 * evaluation results that signal whether the planner is ready for
 * coefficient calibration.
 *
 * Surfaces:
 *   - average candidate rejection rate
 *   - average intralesional fraction (V_H_norm of selected trajectory)
 *   - average min vessel / ventricle / sinus margin
 *   - average angular deviation vs expert (when available)
 *
 * These numbers should be inspected BEFORE running grid-search
 * tuning.  If rejection rate is > 90 %, or intralesional fraction is
 * near zero, the generator or voxeliser likely has a problem.
 */

import type { CaseResult, BatchResult } from './BatchEvaluator';

// ─── types ──────────────────────────────────────────────────────────

export interface TuningReadinessReport {
  caseCount: number;
  casesWithTrajectory: number;
  casesWithExpert: number;

  avgRejectionRate: number;
  avgIntralesionalFraction: number;

  avgMinVesselMarginMm: number;
  avgMinVentMarginMm: number;
  avgMinSinusMarginMm: number;

  /** Only populated when expert trajectories are available. */
  avgAngularDeviationDeg: number | null;
  avgEntryDistanceMm: number | null;

  /** High-level readiness flags. */
  flags: ReadinessFlag[];
}

export interface ReadinessFlag {
  code: string;
  ok: boolean;
  message: string;
}

// ─── helpers ────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function finiteOnly(arr: number[]): number[] {
  return arr.filter(Number.isFinite);
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Compute a tuning-readiness report from a batch evaluation result.
 */
export function buildTuningReadiness(batch: BatchResult): TuningReadinessReport {
  const cases = batch.cases;

  // Rejection rates
  const rejectionRates = cases.map(c =>
    c.pipeline.generated > 0
      ? (c.pipeline.generated - c.pipeline.passedHardConstraints) / c.pipeline.generated
      : 0,
  );

  // Intralesional fractions (V_H_norm of selected trajectory)
  const ilFracs = cases
    .filter(c => c.selectedTrajectory !== null)
    .map(c => c.selectedTrajectory!.breakdown.vhNorm);

  // Min margins of selected trajectories
  const vesselMargins = finiteOnly(
    cases.filter(c => c.selectedTrajectory).map(c => c.selectedTrajectory!.minVesselMarginMm),
  );
  const ventMargins = finiteOnly(
    cases.filter(c => c.selectedTrajectory).map(c => c.selectedTrajectory!.minVentMarginMm),
  );
  const sinusMargins = finiteOnly(
    cases.filter(c => c.selectedTrajectory).map(c => c.selectedTrajectory!.minSinusMarginMm),
  );

  // Expert comparison
  const angularDevs = cases
    .filter(c => c.metricsVsExpert !== null)
    .map(c => c.metricsVsExpert!.angularDeviation);

  const entryDists = cases
    .filter(c => c.metricsVsExpert !== null)
    .map(c => c.metricsVsExpert!.entryDistance);

  const casesWithTraj = cases.filter(c => c.selectedTrajectory !== null).length;
  const casesWithExpert = cases.filter(c => c.metricsVsExpert !== null).length;

  const avgReject = avg(rejectionRates);
  const avgIL = avg(ilFracs);
  const avgVessel = avg(vesselMargins);
  const avgVent = avg(ventMargins);
  const avgSinus = avg(sinusMargins);
  const avgAngle = angularDevs.length > 0 ? avg(angularDevs) : null;
  const avgEntry = entryDists.length > 0 ? avg(entryDists) : null;

  // Readiness flags
  const flags: ReadinessFlag[] = [];

  flags.push({
    code: 'TRAJECTORY_RATE',
    ok: casesWithTraj === cases.length,
    message: casesWithTraj === cases.length
      ? `All ${cases.length} cases produced a trajectory.`
      : `${cases.length - casesWithTraj} of ${cases.length} cases have no trajectory — check generator or hard constraints.`,
  });

  flags.push({
    code: 'REJECTION_RATE',
    ok: avgReject < 0.9,
    message: avgReject < 0.9
      ? `Average rejection rate ${(avgReject * 100).toFixed(1)}% is acceptable.`
      : `Average rejection rate ${(avgReject * 100).toFixed(1)}% is very high — cone angle or dilation may be too aggressive.`,
  });

  flags.push({
    code: 'INTRALESIONAL',
    ok: avgIL > 0.01,
    message: avgIL > 0.01
      ? `Average intralesional fraction ${(avgIL * 100).toFixed(1)}%.`
      : `Average intralesional fraction ${(avgIL * 100).toFixed(1)}% is near zero — PCA axis or entry resolution may be broken.`,
  });

  if (avgAngle !== null) {
    flags.push({
      code: 'ANGULAR_DEV',
      ok: avgAngle < 45,
      message: avgAngle < 45
        ? `Average angular deviation vs expert: ${avgAngle.toFixed(1)}°.`
        : `Average angular deviation vs expert: ${avgAngle.toFixed(1)}° — planner and expert may be fundamentally misaligned.`,
    });
  }

  flags.push({
    code: 'SAFETY_CHECKS',
    ok: cases.every(c => c.safety.valid),
    message: cases.every(c => c.safety.valid)
      ? 'All cases pass safety validation.'
      : `${cases.filter(c => !c.safety.valid).length} cases have safety violations.`,
  });

  return {
    caseCount: cases.length,
    casesWithTrajectory: casesWithTraj,
    casesWithExpert,
    avgRejectionRate: avgReject,
    avgIntralesionalFraction: avgIL,
    avgMinVesselMarginMm: avgVessel,
    avgMinVentMarginMm: avgVent,
    avgMinSinusMarginMm: avgSinus,
    avgAngularDeviationDeg: avgAngle,
    avgEntryDistanceMm: avgEntry,
    flags,
  };
}

/**
 * Format a TuningReadinessReport as a human-readable multi-line string.
 */
export function formatTuningReadiness(r: TuningReadinessReport): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);
  const f = (n: number | null, d = 2) =>
    n === null ? 'n/a' : (Number.isFinite(n) ? n.toFixed(d) : '∞');

  p('═══ Tuning Readiness Report ═══');
  p('');
  p(`  Cases:           ${r.caseCount}`);
  p(`  With trajectory: ${r.casesWithTrajectory}`);
  p(`  With expert:     ${r.casesWithExpert}`);
  p('');
  p('── Averages ──');
  p(`  Rejection rate:           ${(r.avgRejectionRate * 100).toFixed(1)}%`);
  p(`  Intralesional fraction:   ${(r.avgIntralesionalFraction * 100).toFixed(1)}%`);
  p(`  Min vessel margin:        ${f(r.avgMinVesselMarginMm)} mm`);
  p(`  Min ventricle margin:     ${f(r.avgMinVentMarginMm)} mm`);
  p(`  Min sinus margin:         ${f(r.avgMinSinusMarginMm)} mm`);
  p(`  Angular dev vs expert:    ${f(r.avgAngularDeviationDeg)}°`);
  p(`  Entry dist vs expert:     ${f(r.avgEntryDistanceMm)} mm`);
  p('');
  p('── Readiness flags ──');
  for (const flag of r.flags) {
    p(`  [${flag.ok ? 'OK' : 'WARN'}] ${flag.code}: ${flag.message}`);
  }
  p('════════════════════════════════');

  return lines.join('\n');
}
