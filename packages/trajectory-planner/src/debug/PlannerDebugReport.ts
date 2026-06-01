/**
 * PlannerDebugReport — structured diagnostic snapshot of a single
 * optimizer run.  Pure data extraction, no side effects.
 *
 * Designed for console logging, JSON export, and UI overlay binding.
 */

import type {
  PCAResult,
  PCAAnisotropy,
  ScoredTrajectory,
  ScoreBreakdown,
  MaskStats,
  VoxelizeResult,
  TrajectoryHitPoints,
} from '../types';
import type { OptimizationResult } from '../planner/TrajectoryOptimizer';

// ─── report types ───────────────────────────────────────────────────

export interface CandidateSummary {
  rank: number;
  score: number;
  breakdown: ScoreBreakdown;
  hitPoints: TrajectoryHitPoints;
  entry: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  lengthMm: number;
  minVesselMarginMm: number;
  minVentMarginMm: number;
  minSinusMarginMm: number;
}

export interface PlannerDebugReport {
  // ── PCA ─────────────────────────────────────
  pca: {
    center: { x: number; y: number; z: number };
    axis: { x: number; y: number; z: number };
    eigenValues: [number, number, number];
    anisotropy: PCAAnisotropy;
  };

  // ── Candidate pipeline ──────────────────────
  candidatesGenerated: number;
  candidatesRejectedHard: number;
  candidatesScorable: number;
  rejectionRate: number;

  // ── Top 10 candidates ───────────────────────
  topCandidates: CandidateSummary[];

  // ── Selected trajectory (rank 0) ────────────
  selected: CandidateSummary | null;

  // ── Mask statistics ─────────────────────────
  maskStats: VoxelizeResult['stats'];

  // ── Timing ──────────────────────────────────
  elapsedMs: number;
}

// ─── helpers ────────────────────────────────────────────────────────

function vec3Json(v: { x: number; y: number; z: number }) {
  return { x: v.x, y: v.y, z: v.z };
}

function candidateSummary(t: ScoredTrajectory, rank: number): CandidateSummary {
  return {
    rank,
    score: t.score,
    breakdown: t.scoreBreakdown,
    hitPoints: t.hitPoints,
    entry: vec3Json(t.entry),
    direction: vec3Json(t.direction),
    lengthMm: t.length,
    minVesselMarginMm: t.scoreBreakdown.dVessel,
    minVentMarginMm: t.scoreBreakdown.dVent,
    minSinusMarginMm: t.scoreBreakdown.dSinus,
  };
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Extract a structured debug report from an OptimizationResult.
 * The report is a plain object — safe to JSON.stringify.
 */
export function buildDebugReport(result: OptimizationResult): PlannerDebugReport {
  const { pca, trajectories, stats, maskStats } = result;

  const topCandidates = trajectories
    .slice(0, 10)
    .map((t, i) => candidateSummary(t, i));

  const selected = trajectories.length > 0
    ? candidateSummary(trajectories[0], 0)
    : null;

  const rejectedHard = stats.generated - stats.passedHardConstraints;
  const rejectionRate = stats.generated > 0
    ? rejectedHard / stats.generated
    : 0;

  return {
    pca: {
      center: vec3Json(pca.center),
      axis: vec3Json(pca.principalAxis),
      eigenValues: pca.eigenValues,
      anisotropy: pca.anisotropy,
    },
    candidatesGenerated: stats.generated,
    candidatesRejectedHard: rejectedHard,
    candidatesScorable: stats.scored,
    rejectionRate,
    topCandidates,
    selected,
    maskStats,
    elapsedMs: stats.elapsedMs,
  };
}

/**
 * Format a PlannerDebugReport as a human-readable multi-line string
 * suitable for console output.
 */
export function formatDebugReport(r: PlannerDebugReport): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);
  const f = (n: number, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '∞';

  p('═══ Voxel Planner Debug Report ═══');
  p('');
  p('── PCA ──');
  p(`  Centre:      (${f(r.pca.center.x)}, ${f(r.pca.center.y)}, ${f(r.pca.center.z)})`);
  p(`  Axis:        (${f(r.pca.axis.x, 4)}, ${f(r.pca.axis.y, 4)}, ${f(r.pca.axis.z, 4)})`);
  p(`  Eigenvalues: [${r.pca.eigenValues.map(v => f(v, 4)).join(', ')}]`);
  p(`  Elongation:  ${f(r.pca.anisotropy.elongation)}  Flatness: ${f(r.pca.anisotropy.flatness)}  Spread: ${f(r.pca.anisotropy.spread)}`);
  p(`  Stable axis: ${r.pca.anisotropy.isStable ? 'YES' : 'NO (hematoma ~spherical)'}`);
  p('');
  p('── Candidate pipeline ──');
  p(`  Generated:     ${r.candidatesGenerated}`);
  p(`  Hard rejected: ${r.candidatesRejectedHard}  (${(r.rejectionRate * 100).toFixed(1)}%)`);
  p(`  Scorable:      ${r.candidatesScorable}`);
  p('');
  p('── Mask stats ──');
  const ms = r.maskStats;
  p(`  Hematoma:  ${ms.hematoma.voxelCount} voxels, ${f(ms.hematoma.estimatedVolumeMm3, 0)} mm³`);
  if (ms.vessel) p(`  Vessel:    ${ms.vessel.voxelCount} voxels, ${f(ms.vessel.estimatedVolumeMm3, 0)} mm³`);
  if (ms.ventricle) p(`  Ventricle: ${ms.ventricle.voxelCount} voxels, ${f(ms.ventricle.estimatedVolumeMm3, 0)} mm³`);
  if (ms.sinus) p(`  Sinus:     ${ms.sinus.voxelCount} voxels, ${f(ms.sinus.estimatedVolumeMm3, 0)} mm³`);
  p('');

  if (r.topCandidates.length > 0) {
    p('── Top candidates ──');
    p('  Rank | Score   | V_H%   | D_skin | P_norm | dVessel | dVent  | dSinus');
    p('  ─────┼─────────┼────────┼────────┼────────┼─────────┼────────┼────────');
    for (const c of r.topCandidates) {
      const b = c.breakdown;
      p(`  ${String(c.rank).padStart(4)} | ${f(c.score, 4).padStart(7)} | ${f(b.vhNorm * 100, 1).padStart(5)}% | ${f(b.dSkinRaw, 1).padStart(6)} | ${f(b.proximityNorm, 4).padStart(6)} | ${f(b.dVessel, 1).padStart(7)} | ${f(b.dVent, 1).padStart(6)} | ${f(b.dSinus, 1).padStart(6)}`);
    }
    p('');
  }

  if (r.selected) {
    p('── Selected trajectory ──');
    p(`  Entry:   (${f(r.selected.entry.x)}, ${f(r.selected.entry.y)}, ${f(r.selected.entry.z)})`);
    p(`  Dir:     (${f(r.selected.direction.x, 4)}, ${f(r.selected.direction.y, 4)}, ${f(r.selected.direction.z, 4)})`);
    p(`  Length:  ${f(r.selected.lengthMm)} mm`);
    p(`  Score:   ${f(r.selected.score, 4)}`);
    const hp = r.selected.hitPoints;
    if (hp.firstHematomaHit) {
      p(`  1st hematoma hit: (${f(hp.firstHematomaHit.x)}, ${f(hp.firstHematomaHit.y)}, ${f(hp.firstHematomaHit.z)})`);
    }
    p(`  Min margins:  vessel=${f(r.selected.minVesselMarginMm)} mm  vent=${f(r.selected.minVentMarginMm)} mm  sinus=${f(r.selected.minSinusMarginMm)} mm`);
  }

  p('');
  p(`  Total time: ${f(r.elapsedMs, 0)} ms`);
  p('═══════════════════════════════════');

  return lines.join('\n');
}
