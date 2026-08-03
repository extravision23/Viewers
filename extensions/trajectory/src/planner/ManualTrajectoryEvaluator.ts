/**
 * ManualTrajectoryEvaluator — thin adapter that evaluates a manual
 * trajectory through the voxel pipeline to produce clinical metrics
 * (clearances, intralesional coverage, extracerebral path).
 *
 * Re-uses the existing core modules without modifying them.
 */

import * as THREE from 'three';
import type { MeshRole } from '@extravision/trajectory-planner';
import type {
  OptimizerConfig,
  VoxelMasks,
  VoxelizeResult,
  DistanceFieldSet,
} from '@extravision/trajectory-planner';
import {
  DEFAULT_OPTIMIZER_CONFIG,
  voxelizeScene,
  computeDistanceField,
  scoreTrajectory,
} from '@extravision/trajectory-planner';
import type { ObstacleGroups } from '@extravision/trajectory-planner';
import type { TrajectoryMetricsData } from './WorkflowTypes';

/** Cached voxelization so AI suggestion can reuse it. */
export interface VoxelCache {
  voxResult: VoxelizeResult;
  masks: VoxelMasks;
  distanceFields: DistanceFieldSet;
  hematomaVoxelCount: number;
}

/**
 * Voxelize the scene and cache the result. Expensive (~300-1000ms),
 * call once and pass the cache to both manual evaluation and AI
 * suggestion to avoid double work.
 */
export function buildVoxelCache(
  meshesByRole: Map<MeshRole, THREE.Mesh[]>,
  spacing: number = 1.0,
  obstacleGroups?: ObstacleGroups,
): VoxelCache {
  const t0 = performance.now();

  const voxResult = voxelizeScene({
    meshesByRole,
    spacing,
    dilationRadiusMm: 0,
    obstacleGroups,
  });
  const tVox = performance.now();

  const { masks } = voxResult;
  const distanceFields: DistanceFieldSet = {};
  if (masks.vesselMask) distanceFields.vessel = computeDistanceField(masks.vesselMask);
  if (masks.ventricleMask) distanceFields.ventricle = computeDistanceField(masks.ventricleMask);
  if (masks.sinusMask) distanceFields.sinus = computeDistanceField(masks.sinusMask);
  const tDF = performance.now();

  const [nx, ny, nz] = masks.hematomaMask.dims;
  console.log(
    `[Perf] buildVoxelCache: total=${(tDF - t0).toFixed(0)}ms` +
    ` | vox=${(tVox - t0).toFixed(0)} df=${(tDF - tVox).toFixed(0)}` +
    ` | grid=${nx}x${ny}x${nz} spacing=${spacing}mm`
  );

  return {
    voxResult,
    masks,
    distanceFields,
    hematomaVoxelCount: voxResult.stats.hematoma.voxelCount,
  };
}

/**
 * Evaluate a manual trajectory through the voxel scoring pipeline
 * and return clinical metrics. Returns null if evaluation fails
 * (e.g. entry point outside grid, zero hematoma voxels).
 */
export function evaluateManualTrajectory(
  entry: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  cache: VoxelCache,
  config?: Partial<OptimizerConfig>,
): TrajectoryMetricsData | null {
  const resolved: OptimizerConfig = {
    ...DEFAULT_OPTIMIZER_CONFIG,
    ...config,
    coefficients: {
      ...DEFAULT_OPTIMIZER_CONFIG.coefficients,
      ...config?.coefficients,
    },
    generator: {
      ...DEFAULT_OPTIMIZER_CONFIG.generator,
      ...config?.generator,
    },
    gradient: {
      ...DEFAULT_OPTIMIZER_CONFIG.gradient,
      ...config?.gradient,
    },
  };

  if (cache.hematomaVoxelCount === 0) return null;

  try {
    const candidate = { entry, direction: direction.clone().normalize(), length };
    const scored = scoreTrajectory(candidate, {
      masks: cache.masks,
      coefficients: resolved.coefficients,
      distanceFields: cache.distanceFields,
      hematomaVoxelCount: cache.hematomaVoxelCount,
    });

    const bd = scored.scoreBreakdown;
    return {
      vesselClearanceMm: Number.isFinite(bd.dVessel) ? bd.dVessel : null,
      ventricleClearanceMm: Number.isFinite(bd.dVent) ? bd.dVent : null,
      sinusClearanceMm: Number.isFinite(bd.dSinus) ? bd.dSinus : null,
      intralesionalCoverage: Number.isFinite(bd.vhNorm) ? bd.vhNorm * 100 : null,
      extracerebralPathMm: Number.isFinite(bd.dSkinRaw) ? bd.dSkinRaw : null,
    };
  } catch {
    return null;
  }
}

/**
 * Build plain-language recommendation strings from two sets of
 * metrics. Each string highlights a meaningful difference.
 */
export function buildRecommendations(
  manual: TrajectoryMetricsData | null,
  ai: TrajectoryMetricsData | null,
): string[] {
  if (!manual || !ai) return [];
  const lines: string[] = [];

  function compare(
    label: string,
    mVal: number | null,
    aVal: number | null,
    unit: string,
    higherIsBetter: boolean,
  ): void {
    if (mVal === null || aVal === null) return;
    const diff = aVal - mVal;
    if (Math.abs(diff) < 0.1) return;
    const better = higherIsBetter ? (diff > 0 ? 'AI' : 'Manual') : (diff < 0 ? 'AI' : 'Manual');
    const verb = higherIsBetter ? 'greater' : 'shorter';
    lines.push(`${better} trajectory has ${verb} ${label} by ${Math.abs(diff).toFixed(1)} ${unit}`);
  }

  compare('vessel clearance', manual.vesselClearanceMm, ai.vesselClearanceMm, 'mm', true);
  compare('ventricle clearance', manual.ventricleClearanceMm, ai.ventricleClearanceMm, 'mm', true);
  compare('sinus clearance', manual.sinusClearanceMm, ai.sinusClearanceMm, 'mm', true);
  compare('intralesional coverage', manual.intralesionalCoverage, ai.intralesionalCoverage, '%', true);
  compare('extracerebral path', manual.extracerebralPathMm, ai.extracerebralPathMm, 'mm', false);

  return lines;
}
