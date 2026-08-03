/**
 * TrajectoryOptimizer — access-path search with gradient descent.
 *
 * Pipeline:
 *   1. Voxelize scene → masks (+ distance fields, optional corridor dilation)
 *   2. PCA on hematoma mask
 *   3. Discrete cone candidates (seeds + fallback)
 *   4. Multi-start gradient descent on (θ, φ) from hematoma centre
 *   5. Return top K feasible trajectories + diagnostics
 */

import * as THREE from 'three';
import type {
  VoxelMasks,
  VoxelizeResult,
  PCAResult,
  ScoredTrajectory,
  OptimizerConfig,
  ScoringCoefficients,
  DistanceFieldSet,
} from '../types';
import { DEFAULT_OPTIMIZER_CONFIG } from '../types';
import type { MeshRole } from '../roles';
import { voxelizeScene, computeDistanceField, dilateMask, type ObstacleGroups } from '../voxel/Voxelizer';
import { analyzePCA } from '../geometry/PCAAnalyzer';
import { generateCandidates } from './TrajectoryGenerator';
import { violatesHardConstraints, scoreTrajectory } from './TrajectoryEvaluator';
import { optimizeAccessByGradient } from './GradientAccessOptimizer';

// ─── result type ────────────────────────────────────────────────────

export interface OptimizationDiagnostics {
  hasTarget: boolean;
  hasEntrySurface: boolean;
  hasObstacles: boolean;
  generated: number;
  hardRejected: number;
  passedHardConstraints: number;
  gdSeedsTried: number;
  gdFeasible: number;
  sphereHits: number;
  /** Human-readable hints when no safe trajectory is found. */
  hints: string[];
}

export interface OptimizationResult {
  trajectories: ScoredTrajectory[];
  pca: PCAResult;
  masks: VoxelMasks;
  /** Per-mask debug diagnostics (voxel count, volume, bbox coverage). */
  maskStats: VoxelizeResult['stats'];
  stats: {
    generated: number;
    passedHardConstraints: number;
    scored: number;
    elapsedMs: number;
    hardRejected: number;
    gdSeedsTried: number;
    gdFeasible: number;
  };
  diagnostics: OptimizationDiagnostics;
  /** Best hard-blocked candidate (for UI messaging), if any. */
  bestInfeasible: ScoredTrajectory | null;
}

// ─── public API ─────────────────────────────────────────────────────

export interface OptimizeInput {
  meshesByRole: Map<MeshRole, THREE.Mesh[]>;
  maxLength: number;
  config?: Partial<OptimizerConfig>;
  /** Explicit obstacle subtype grouping from user assignment. */
  obstacleGroups?: ObstacleGroups;
  /** Corridor radius (mm); used as dilation when dilationRadiusMm is 0. */
  corridorRadiusMm?: number;
}

/**
 * Worker-ready input: contains only transferable data (no THREE objects).
 * Voxelization happens on the main thread (needs mesh geometry);
 * everything after voxelization (PCA, generation, scoring) is pure math
 * and can run in a Worker using this input type.
 *
 * NOT yet wired — reserved for future Web Worker extraction.
 */
export interface WorkerReadyInput {
  masks: VoxelMasks;
  maskStats: VoxelizeResult['stats'];
  distanceFields: DistanceFieldSet;
  /** Serialised entry surface for raycast (positions + indices). */
  entrySurfaceGeometry: { positions: Float32Array; indices: Uint32Array }[];
  maxLength: number;
  config: OptimizerConfig;
}

function buildHints(input: {
  hasTarget: boolean;
  hasEntrySurface: boolean;
  hasObstacles: boolean;
  generated: number;
  passedHard: number;
  gdFeasible: number;
}): string[] {
  const hints: string[] = [];
  const empty = input.gdFeasible === 0;
  if (!input.hasTarget) {
    hints.push('Assign a TARGET (lesion/hematoma) role before generating AI.');
  }
  if (!input.hasEntrySurface) {
    hints.push('Assign an ENTRY_SURFACE (skin/skull) role for scalp entry points.');
  }
  if (!input.hasObstacles && empty) {
    hints.push(
      'Mark critical structures as OBSTACLE (vessel / ventricle / sinus) so the planner can avoid them.',
    );
  }
  if (input.generated === 0 && input.hasTarget && input.hasEntrySurface) {
    hints.push('No entry-surface hits found — check mesh coverage or increase max length / samples.');
  } else if (input.passedHard === 0 && input.generated > 0) {
    hints.push(
      `All ${input.generated} candidates hit obstacles. Relax OBSTACLE roles, reduce corridor dilation, or widen the search cone.`,
    );
  } else if (empty) {
    hints.push(
      'Gradient search found no safe corridor. Adjust obstacle roles or parameters.',
    );
  }
  return hints;
}

/**
 * Run voxel-based access optimization with multi-start gradient descent.
 * Deterministic: same input always produces same output.
 */
export function optimizeTrajectories(input: OptimizeInput): OptimizationResult {
  const t0 = performance.now();
  const config: OptimizerConfig = {
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
    gradient: {
      ...DEFAULT_OPTIMIZER_CONFIG.gradient,
      ...input.config?.gradient,
    },
  };

  const coefficients: ScoringCoefficients = config.coefficients;
  const corridorFallback = input.corridorRadiusMm ?? 0;
  const dilationRadiusMm =
    (input.config?.dilationRadiusMm ?? config.dilationRadiusMm) > 0
      ? (input.config?.dilationRadiusMm ?? config.dilationRadiusMm)
      : corridorFallback;

  // 1. Voxelize
  const voxResult: VoxelizeResult = voxelizeScene({
    meshesByRole: input.meshesByRole,
    spacing: config.spacing,
    dilationRadiusMm: 0,
    obstacleGroups: input.obstacleGroups,
  });
  const { masks } = voxResult;
  const tVox = performance.now();

  // 2. Distance fields
  const distanceFields: DistanceFieldSet = {};
  if (masks.vesselMask) distanceFields.vessel = computeDistanceField(masks.vesselMask);
  if (masks.ventricleMask) distanceFields.ventricle = computeDistanceField(masks.ventricleMask);
  if (masks.sinusMask) distanceFields.sinus = computeDistanceField(masks.sinusMask);
  const tDF = performance.now();

  // 2b. Dilated masks (corridor safety)
  let dilatedMasks: VoxelMasks | undefined;
  if (dilationRadiusMm > 0) {
    dilatedMasks = {
      hematomaMask: masks.hematomaMask,
      vesselMask: masks.vesselMask ? dilateMask(masks.vesselMask, dilationRadiusMm) : null,
      ventricleMask: masks.ventricleMask ? dilateMask(masks.ventricleMask, dilationRadiusMm) : null,
      sinusMask: masks.sinusMask ? dilateMask(masks.sinusMask, dilationRadiusMm) : null,
      brainMask: masks.brainMask,
    };
  }
  const tDilate = performance.now();

  // 3. PCA
  const pca = analyzePCA(masks.hematomaMask);
  const tPCA = performance.now();

  const generatorCfg = { ...config.generator };
  if (!pca.anisotropy.isStable) {
    generatorCfg.coneHalfAngleDeg = Math.max(generatorCfg.coneHalfAngleDeg, 55);
    generatorCfg.samplesPerCone = Math.max(generatorCfg.samplesPerCone, 500);
    console.log(
      `[SEG→traj] PCA unstable (elongation=${pca.anisotropy.elongation.toFixed(2)}); ` +
        `widened cone to ${generatorCfg.coneHalfAngleDeg}° / ${generatorCfg.samplesPerCone} samples`,
    );
  }

  // 4. Discrete cone candidates (seeds + fallback scoring)
  const entrySurfaceMeshes = input.meshesByRole.get('ENTRY_SURFACE') ?? [];
  const targetMeshes = input.meshesByRole.get('TARGET') ?? [];
  const candidates = generateCandidates({
    pca,
    entrySurfaceMeshes,
    maxLength: input.maxLength,
    config: generatorCfg,
  });
  const generated = candidates.length;
  const tGen = performance.now();

  const filtered = candidates.filter(c => !violatesHardConstraints(c, masks, dilatedMasks));
  const passedHardConstraints = filtered.length;
  const hardRejected = generated - passedHardConstraints;
  const tFilter = performance.now();

  const hematomaVoxelCount = voxResult.stats.hematoma.voxelCount;
  const accessCtx = {
    masks,
    dilatedMasks,
    distanceFields,
    coefficients,
    pca,
    hematomaVoxelCount,
  };

  // 5. Gradient descent multi-start
  const gdResult = optimizeAccessByGradient({
    pca,
    entrySurfaceMeshes,
    maxLength: input.maxLength,
    ctx: accessCtx,
    gradient: config.gradient,
    coneCandidates: filtered.length > 0 ? filtered : candidates.slice(0, 24),
  });
  const tGd = performance.now();

  // Merge GD feasible with discrete survivors (score both with access coefficients)
  const scoredMap = new Map<string, ScoredTrajectory>();
  const addScored = (t: ScoredTrajectory) => {
    const key = `${Math.round(t.entry.x * 2) / 2},${Math.round(t.entry.y * 2) / 2},${Math.round(t.entry.z * 2) / 2}`;
    const prev = scoredMap.get(key);
    if (!prev || t.score > prev.score) scoredMap.set(key, t);
  };

  for (const t of gdResult.feasible) addScored(t);

  for (const c of filtered) {
    addScored(
      scoreTrajectory(c, {
        masks,
        coefficients,
        distanceFields,
        hematomaVoxelCount,
        dilatedMasks,
        pca,
      }),
    );
  }

  const scored = Array.from(scoredMap.values());
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-4) return scoreDiff;
    const extraDiff = a.distSkinToHematoma - b.distSkinToHematoma;
    if (Math.abs(extraDiff) > 0.05) return extraDiff;
    return a.length - b.length;
  });
  const topK = scored.slice(0, config.topK);

  const hasObstacles = !!(
    masks.vesselMask ||
    masks.ventricleMask ||
    masks.sinusMask ||
    (input.obstacleGroups &&
      ((input.obstacleGroups.vessel?.length ?? 0) > 0 ||
        (input.obstacleGroups.ventricle?.length ?? 0) > 0 ||
        (input.obstacleGroups.sinus?.length ?? 0) > 0 ||
        (input.obstacleGroups.other?.length ?? 0) > 0))
  );

  const diagnostics: OptimizationDiagnostics = {
    hasTarget: targetMeshes.length > 0 && hematomaVoxelCount > 0,
    hasEntrySurface: entrySurfaceMeshes.length > 0,
    hasObstacles,
    generated,
    hardRejected,
    passedHardConstraints,
    gdSeedsTried: gdResult.stats.seedsTried,
    gdFeasible: gdResult.stats.feasibleFound,
    sphereHits: gdResult.stats.sphereHits,
    hints: buildHints({
      hasTarget: targetMeshes.length > 0 && hematomaVoxelCount > 0,
      hasEntrySurface: entrySurfaceMeshes.length > 0,
      hasObstacles,
      generated,
      passedHard: passedHardConstraints,
      gdFeasible: topK.length,
    }),
  };

  const elapsedMs = performance.now() - t0;
  const [nx, ny, nz] = masks.hematomaMask.dims;

  console.log(
    `[Perf] optimize: total=${elapsedMs.toFixed(0)}ms` +
      ` | vox=${(tVox - t0).toFixed(0)} df=${(tDF - tVox).toFixed(0)}` +
      ` dil=${(tDilate - tDF).toFixed(0)} pca=${(tPCA - tDilate).toFixed(0)}` +
      ` gen=${(tGen - tPCA).toFixed(0)} filter=${(tFilter - tGen).toFixed(0)}` +
      ` gd=${(tGd - tFilter).toFixed(0)}` +
      ` | grid=${nx}x${ny}x${nz} (${((nx * ny * nz) / 1e6).toFixed(1)}M)` +
      ` cand=${generated} pass=${passedHardConstraints} gdFeasible=${gdResult.stats.feasibleFound} top=${topK.length}`,
  );

  return {
    trajectories: topK,
    pca,
    masks,
    maskStats: voxResult.stats,
    stats: {
      generated,
      passedHardConstraints,
      scored: scored.length,
      elapsedMs,
      hardRejected,
      gdSeedsTried: gdResult.stats.seedsTried,
      gdFeasible: gdResult.stats.feasibleFound,
    },
    diagnostics,
    bestInfeasible: gdResult.bestInfeasible,
  };
}
