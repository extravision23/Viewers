/**
 * ExperimentScorer — rank cases from a batch result using four
 * complementary strategies, then produce a balanced composite.
 *
 * Rankings (lower rank = better):
 *
 *   1. Safety-first:
 *      Penalise any safety violation, then rank by minimum obstacle
 *      margin (higher margin = better).
 *
 *   2. Expert-similarity:
 *      Rank by combined angular deviation + entry distance vs expert.
 *      Cases without expert data get worst rank.
 *
 *   3. Intralesional-efficiency:
 *      Rank by normalised intralesional fraction (V_H_norm), higher
 *      = better.
 *
 *   4. Balanced composite:
 *      Average of the three per-case ranks above (lower = better).
 */

import type { CaseResult } from '../debug/BatchEvaluator';

// ─── types ──────────────────────────────────────────────────────────

export interface CaseRanking {
  caseId: string;
  safetyRank: number;
  expertRank: number;
  efficiencyRank: number;
  compositeRank: number;
  compositeScore: number;
}

export interface ExperimentScore {
  rankings: CaseRanking[];
  /** Index into `rankings` of the best case by composite score. */
  bestCaseIndex: number;
  /** Index of worst case by composite score. */
  worstCaseIndex: number;
}

// ─── internal helpers ───────────────────────────────────────────────

/**
 * Assign dense 1-based ranks to `items` by the given comparator.
 * Equal values share the same rank (competition ranking).
 * Returns an array of ranks in the same order as `items`.
 */
function rankBy<T>(items: T[], valueOf: (item: T) => number, ascending: boolean): number[] {
  const indexed = items.map((item, i) => ({ i, v: valueOf(item) }));
  indexed.sort((a, b) => ascending ? a.v - b.v : b.v - a.v);

  const ranks = new Array<number>(items.length);
  let currentRank = 1;
  for (let k = 0; k < indexed.length; k++) {
    if (k > 0 && indexed[k].v !== indexed[k - 1].v) {
      currentRank = k + 1;
    }
    ranks[indexed[k].i] = currentRank;
  }
  return ranks;
}

// ─── safety metric ──────────────────────────────────────────────────

function safetySortValue(c: CaseResult): number {
  // Violated = pushed to bottom (large value).
  // Then sort by min margin ascending (lower margin = worse = higher value).
  const VIOLATION_PENALTY = 1e6;
  const base = c.safety.valid ? 0 : VIOLATION_PENALTY;

  if (!c.selectedTrajectory) return base + VIOLATION_PENALTY;

  const minMargin = Math.min(
    Number.isFinite(c.selectedTrajectory.minVesselMarginMm)
      ? c.selectedTrajectory.minVesselMarginMm : Infinity,
    Number.isFinite(c.selectedTrajectory.minVentMarginMm)
      ? c.selectedTrajectory.minVentMarginMm : Infinity,
    Number.isFinite(c.selectedTrajectory.minSinusMarginMm)
      ? c.selectedTrajectory.minSinusMarginMm : Infinity,
  );

  // Higher margin = better = lower sort value.
  return base + (Number.isFinite(minMargin) ? -minMargin : VIOLATION_PENALTY);
}

// ─── expert-similarity metric ───────────────────────────────────────

function expertSortValue(c: CaseResult): number {
  if (!c.metricsVsExpert) return 1e9;
  // Lower combined deviation = better
  return c.metricsVsExpert.angularDeviation + c.metricsVsExpert.entryDistance;
}

// ─── efficiency metric ──────────────────────────────────────────────

function efficiencySortValue(c: CaseResult): number {
  if (!c.selectedTrajectory) return 0;
  return c.selectedTrajectory.breakdown.vhNorm;
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Score and rank all cases from a batch result.
 */
export function scoreExperiment(cases: CaseResult[]): ExperimentScore {
  if (cases.length === 0) {
    return { rankings: [], bestCaseIndex: -1, worstCaseIndex: -1 };
  }

  // ascending = true means lower value gets rank 1
  const safetyRanks = rankBy(cases, safetySortValue, true);
  const expertRanks = rankBy(cases, expertSortValue, true);
  const efficiencyRanks = rankBy(cases, efficiencySortValue, false);

  const rankings: CaseRanking[] = cases.map((c, i) => {
    const compositeScore = (safetyRanks[i] + expertRanks[i] + efficiencyRanks[i]) / 3;
    return {
      caseId: c.caseId,
      safetyRank: safetyRanks[i],
      expertRank: expertRanks[i],
      efficiencyRank: efficiencyRanks[i],
      compositeRank: 0, // filled below
      compositeScore,
    };
  });

  // Assign composite ranks from composite scores (lower score = better)
  const compositeRanks = rankBy(rankings, r => r.compositeScore, true);
  for (let i = 0; i < rankings.length; i++) {
    rankings[i].compositeRank = compositeRanks[i];
  }

  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 1; i < rankings.length; i++) {
    if (rankings[i].compositeScore < rankings[bestIdx].compositeScore) bestIdx = i;
    if (rankings[i].compositeScore > rankings[worstIdx].compositeScore) worstIdx = i;
  }

  return { rankings, bestCaseIndex: bestIdx, worstCaseIndex: worstIdx };
}

/**
 * Format the experiment score as a human-readable table.
 */
export function formatExperimentScore(score: ExperimentScore): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('═══ Experiment Rankings ═══');
  p('');
  p('  Case             | Safety | Expert | Efficiency | Composite');
  p('  ─────────────────┼────────┼────────┼────────────┼──────────');

  const sorted = [...score.rankings].sort((a, b) => a.compositeRank - b.compositeRank);
  for (const r of sorted) {
    const id = r.caseId.padEnd(17).slice(0, 17);
    p(`  ${id}| ${String(r.safetyRank).padStart(6)} | ${String(r.expertRank).padStart(6)} | ${String(r.efficiencyRank).padStart(10)} | ${String(r.compositeRank).padStart(5)} (${r.compositeScore.toFixed(1)})`);
  }

  p('');
  if (score.bestCaseIndex >= 0) {
    p(`  Best:  ${score.rankings[score.bestCaseIndex].caseId} (composite ${score.rankings[score.bestCaseIndex].compositeScore.toFixed(1)})`);
  }
  if (score.worstCaseIndex >= 0) {
    p(`  Worst: ${score.rankings[score.worstCaseIndex].caseId} (composite ${score.rankings[score.worstCaseIndex].compositeScore.toFixed(1)})`);
  }
  p('═══════════════════════════');

  return lines.join('\n');
}
