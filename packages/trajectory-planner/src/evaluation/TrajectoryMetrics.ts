/**
 * TrajectoryMetrics — quantitative comparison between an algorithm-
 * planned trajectory and an expert (ground-truth) trajectory.
 *
 * All distances in mm, angles in degrees.
 */

import * as THREE from 'three';
import type {
  VoxelGrid,
  VoxelMasks,
  ComparisonMetrics,
  TrajectoryCandidate,
  DistanceFieldSet,
} from '../types';
import { gridIndex, gridToWorld } from '../voxel/Voxelizer';

// ─── helpers ────────────────────────────────────────────────────────

/** Angular deviation between two unit direction vectors (degrees). */
function angularDev(u: THREE.Vector3, v: THREE.Vector3): number {
  const dot = Math.max(-1, Math.min(1, u.dot(v)));
  return (Math.acos(Math.abs(dot)) * 180) / Math.PI;
}

/**
 * Compute intralesional length: total length of the trajectory
 * segment that lies inside the hematoma mask.
 */
function intralesionalLength(
  traj: TrajectoryCandidate,
  hematomaMask: VoxelGrid,
): number {
  const sp = hematomaMask.spacing;
  const stepSize = sp * 0.5;
  const steps = Math.ceil(traj.length / stepSize);
  let count = 0;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * traj.length;
    const p = traj.entry.clone().addScaledVector(traj.direction, t);
    const [ix, iy, iz] = worldToGridClamped(hematomaMask, p);
    if (hematomaMask.data[gridIndex(hematomaMask, ix, iy, iz)] === 1) {
      count++;
    }
  }

  return count * stepSize;
}

function worldToGridClamped(grid: VoxelGrid, p: THREE.Vector3): [number, number, number] {
  const [nx, ny, nz] = grid.dims;
  const ix = Math.round((p.x - grid.origin.x) / grid.spacing);
  const iy = Math.round((p.y - grid.origin.y) / grid.spacing);
  const iz = Math.round((p.z - grid.origin.z) / grid.spacing);
  return [
    Math.max(0, Math.min(nx - 1, ix)),
    Math.max(0, Math.min(ny - 1, iy)),
    Math.max(0, Math.min(nz - 1, iz)),
  ];
}

/**
 * Minimum distance from a trajectory's sampled points to the nearest
 * set voxel in the given mask.
 */
function minMargin(
  traj: TrajectoryCandidate,
  mask: VoxelGrid | null,
  distField: Float32Array | null,
): number {
  if (!mask) return Infinity;

  const sp = mask.spacing;
  const stepSize = sp;
  const steps = Math.ceil(traj.length / stepSize);
  let best = Infinity;

  if (distField) {
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * traj.length;
      const p = traj.entry.clone().addScaledVector(traj.direction, t);
      const [ix, iy, iz] = worldToGridClamped(mask, p);
      const d = distField[gridIndex(mask, ix, iy, iz)];
      if (d < best) best = d;
    }
    return best;
  }

  // Brute-force fallback
  const [mnx, mny, mnz] = mask.dims;
  const maskPts: THREE.Vector3[] = [];
  for (let iz = 0; iz < mnz; iz++) {
    for (let iy = 0; iy < mny; iy++) {
      for (let ix = 0; ix < mnx; ix++) {
        if (mask.data[gridIndex(mask, ix, iy, iz)] === 1) {
          maskPts.push(gridToWorld(mask, ix, iy, iz));
        }
      }
    }
  }
  if (maskPts.length === 0) return Infinity;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * traj.length;
    const wp = traj.entry.clone().addScaledVector(traj.direction, t);
    for (const mp of maskPts) {
      const d = wp.distanceTo(mp);
      if (d < best) best = d;
    }
  }
  return best;
}

// ─── public API ─────────────────────────────────────────────────────

export interface MetricsInput {
  expert: TrajectoryCandidate;
  algorithm: TrajectoryCandidate;
  masks: VoxelMasks;
  distanceFields?: DistanceFieldSet;
}

/**
 * Compare an algorithm trajectory to an expert trajectory.
 */
export function computeMetrics(input: MetricsInput): ComparisonMetrics {
  const { expert, algorithm, masks, distanceFields } = input;

  const angularDeviation = angularDev(expert.direction, algorithm.direction);
  const entryDistance = expert.entry.distanceTo(algorithm.entry);

  // Target point = entry + direction * length
  const expertTarget = expert.entry.clone().addScaledVector(expert.direction, expert.length);
  const algoTarget = algorithm.entry.clone().addScaledVector(algorithm.direction, algorithm.length);
  const targetDistance = expertTarget.distanceTo(algoTarget);

  const ilExp = intralesionalLength(expert, masks.hematomaMask);
  const ilAlg = intralesionalLength(algorithm, masks.hematomaMask);
  const intralesionalLengthDiff = ilAlg - ilExp;

  const vesselMarginExp = minMargin(expert, masks.vesselMask, distanceFields?.vessel ?? null);
  const vesselMarginAlg = minMargin(algorithm, masks.vesselMask, distanceFields?.vessel ?? null);
  const vesselMarginDiff = vesselMarginAlg - vesselMarginExp;

  const ventMarginExp = minMargin(expert, masks.ventricleMask, distanceFields?.ventricle ?? null);
  const ventMarginAlg = minMargin(algorithm, masks.ventricleMask, distanceFields?.ventricle ?? null);
  const ventMarginDiff = ventMarginAlg - ventMarginExp;

  const sinusMarginExp = minMargin(expert, masks.sinusMask, distanceFields?.sinus ?? null);
  const sinusMarginAlg = minMargin(algorithm, masks.sinusMask, distanceFields?.sinus ?? null);
  const sinusMarginDiff = sinusMarginAlg - sinusMarginExp;

  return {
    angularDeviation,
    entryDistance,
    targetDistance,
    intralesionalLengthDiff,
    vesselMarginDiff,
    ventMarginDiff,
    sinusMarginDiff,
  };
}
