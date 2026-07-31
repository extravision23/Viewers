/**
 * TrajectoryOptimizer — deterministic search loop.
 *
 * Pipeline:
 *   1. Voxelize scene → masks (+ optional distance fields)
 *   2. PCA on hematoma mask
 *   3. Generate candidates (PCA + cone)
 *   4. Filter (hard constraints)
 *   5. Score all surviving candidates
 *   6. Return top K (default 5)
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

// ─── result type ────────────────────────────────────────────────────

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
  };
}

// ─── public API ─────────────────────────────────────────────────────

export interface OptimizeInput {
  meshesByRole: Map<MeshRole, THREE.Mesh[]>;
  maxLength: number;
  config?: Partial<OptimizerConfig>;
  /** Explicit obstacle subtype grouping from user assignment. */
  obstacleGroups?: ObstacleGroups;
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

/**
 * Run the full voxel-based, PCA-guided trajectory optimization.
 * Deterministic: same input always produces same output.
 */
export function optimizeTrajectories(input: OptimizeInput): OptimizationResult {
  const t0 = performance.now();
  const config: OptimizerConfig = { ...DEFAULT_OPTIMIZER_CONFIG, ...input.config };

  const generator = { ...DEFAULT_OPTIMIZER_CONFIG.generator, ...input.config?.generator };
  const coefficients: ScoringCoefficients = {
    ...DEFAULT_OPTIMIZER_CONFIG.coefficients,
    ...input.config?.coefficients,
  };
  const dilationRadiusMm = input.config?.dilationRadiusMm ?? config.dilationRadiusMm;

  // 1. Voxelize (uses explicit obstacle subtype groups when provided)
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

  // 2b. Dilated masks (optional)
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

  // Widen the search cone when the hematoma is roughly spherical —
  // principal axis is then arbitrary and a narrow cone misses short entries.
  const generatorCfg = { ...generator };
  if (!pca.anisotropy.isStable) {
    generatorCfg.coneHalfAngleDeg = Math.max(generatorCfg.coneHalfAngleDeg, 55);
    generatorCfg.samplesPerCone = Math.max(generatorCfg.samplesPerCone, 500);
    console.log(
      `[SEG→traj] PCA unstable (elongation=${pca.anisotropy.elongation.toFixed(2)}); ` +
        `widened cone to ${generatorCfg.coneHalfAngleDeg}° / ${generatorCfg.samplesPerCone} samples`
    );
  }

  // 4. Generate candidates
  const entrySurfaceMeshes = input.meshesByRole.get('ENTRY_SURFACE') ?? [];
  const candidates = generateCandidates({
    pca,
    entrySurfaceMeshes,
    maxLength: input.maxLength,
    config: generatorCfg,
  });
  const generated = candidates.length;
  const tGen = performance.now();

  // 5. Hard-constraint filter
  const filtered = candidates.filter(c => !violatesHardConstraints(c, masks, dilatedMasks));
  const passedHardConstraints = filtered.length;
  const tFilter = performance.now();

  // 6. Score
  const hematomaVoxelCount = voxResult.stats.hematoma.voxelCount;
  const scored = filtered.map(c =>
    scoreTrajectory(c, { masks, coefficients, distanceFields, hematomaVoxelCount, dilatedMasks }),
  );
  const tScore = performance.now();

  // 7. Sort + top K (prefer shorter extracerebral / total length on near-ties)
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-4) return scoreDiff;
    const extraDiff = a.distSkinToHematoma - b.distSkinToHematoma;
    if (Math.abs(extraDiff) > 0.05) return extraDiff;
    return a.length - b.length;
  });
  const topK = scored.slice(0, config.topK);

  const elapsedMs = performance.now() - t0;
  const [nx, ny, nz] = masks.hematomaMask.dims;

  console.log(
    `[Perf] optimize: total=${elapsedMs.toFixed(0)}ms` +
    ` | vox=${(tVox - t0).toFixed(0)} df=${(tDF - tVox).toFixed(0)}` +
    ` dil=${(tDilate - tDF).toFixed(0)} pca=${(tPCA - tDilate).toFixed(0)}` +
    ` gen=${(tGen - tPCA).toFixed(0)} filter=${(tFilter - tGen).toFixed(0)}` +
    ` score=${(tScore - tFilter).toFixed(0)}` +
    ` | grid=${nx}x${ny}x${nz} (${(nx*ny*nz/1e6).toFixed(1)}M)` +
    ` cand=${generated} pass=${passedHardConstraints} scored=${scored.length}`
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
    },
  };
}
