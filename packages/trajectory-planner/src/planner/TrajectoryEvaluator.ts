/**
 * TrajectoryEvaluator — hard-constraint filtering + scoring function.
 *
 * Hard constraints:
 *   Reject any trajectory that traverses a voxel in vesselMask,
 *   ventricleMask, or sinusMask.  When `dilatedMasks` are provided,
 *   the hard-constraint check uses the dilated versions, effectively
 *   enforcing a corridor-radius safety margin without explicit
 *   corridor geometry.
 *
 * Scoring function (higher = better):
 *
 *   Score(T) = α·V_H_norm − β·D_skin_norm − γ·P_norm
 *
 * ── Normalisation strategy ───────────────────────────────────────
 *
 *   V_H_norm    = V_H(T)            / hematomaVoxelCount    ∈ [0, 1]
 *   D_skin_norm = D_skin_to_hema(T) / trajectoryLength      ∈ [0, 1]
 *   P_norm      = 1 − exp(−P_raw)                           ∈ [0, 1)
 *
 * By mapping every raw term to [0, 1] *before* applying weights the
 * coefficients become patient- and resolution-independent, which is
 * critical for reproducible calibration across cases.
 *
 * Raw P(T) is:
 *   w_vessel / (d_vessel + ε)
 * + w_vent   / (d_vent   + ε)
 * + w_sinus  / (d_sinus  + ε)
 *
 * P_norm = 1 − exp(−P_raw) is a soft-saturation that maps the
 * unbounded inverse-distance sum to (0, 1).  When all distances are
 * large, P_raw→0 and P_norm→0.  When any distance is tiny, P_raw→∞
 * and P_norm→1.
 * ──────────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import type {
  VoxelGrid,
  VoxelMasks,
  TrajectoryCandidate,
  ScoredTrajectory,
  ScoringCoefficients,
  TrajectoryHitPoints,
  ScoreBreakdown,
  DistanceFieldSet,
} from '../types';
import { DEFAULT_COEFFICIENTS } from '../types';
import { gridIndex, gridToWorld } from '../voxel/Voxelizer';

const EPS = 0.01; // mm – avoids division by zero in proximity penalty

// ─── voxel traversal (3-D DDA) ──────────────────────────────────────

interface TraversalResult {
  /** Grid indices visited along the ray. */
  visited: [number, number, number][];
}

/**
 * Walk a ray through the voxel grid using a 3-D DDA (Amanatides &
 * Woo) and return every visited cell.
 */
function traverseRay(
  grid: VoxelGrid,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
): TraversalResult {
  const [nx, ny, nz] = grid.dims;
  const sp = grid.spacing;
  const ox = (origin.x - grid.origin.x) / sp;
  const oy = (origin.y - grid.origin.y) / sp;
  const oz = (origin.z - grid.origin.z) / sp;

  const dx = direction.x;
  const dy = direction.y;
  const dz = direction.z;

  let ix = Math.floor(ox);
  let iy = Math.floor(oy);
  let iz = Math.floor(oz);

  const stepX = dx >= 0 ? 1 : -1;
  const stepY = dy >= 0 ? 1 : -1;
  const stepZ = dz >= 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx !== 0 ? ((dx > 0 ? ix + 1 : ix) - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? iy + 1 : iy) - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? iz + 1 : iz) - oz) / dz : Infinity;

  const tEnd = length / sp;
  const visited: [number, number, number][] = [];

  const maxSteps = (nx + ny + nz) * 2; // safety limit
  for (let step = 0; step < maxSteps; step++) {
    if (ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz) {
      visited.push([ix, iy, iz]);
    }

    const tMin = Math.min(tMaxX, tMaxY, tMaxZ);
    if (tMin > tEnd) break;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY;
      tMaxY += tDeltaY;
    } else {
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  return { visited };
}

// ─── hard constraint check ──────────────────────────────────────────

/**
 * Returns true if the trajectory violates any hard constraint (i.e.
 * traverses a forbidden structure).
 *
 * When `dilatedMasks` are provided they are used *instead of* the
 * base masks for the intersection test, effectively enforcing a
 * corridor-radius safety margin.
 */
export function violatesHardConstraints(
  candidate: TrajectoryCandidate,
  masks: VoxelMasks,
  dilatedMasks?: VoxelMasks,
): boolean {
  const grid = masks.hematomaMask; // shared lattice
  const effective = dilatedMasks ?? masks;

  const forbidden: VoxelGrid[] = [];
  if (effective.vesselMask) forbidden.push(effective.vesselMask);
  if (effective.ventricleMask) forbidden.push(effective.ventricleMask);
  if (effective.sinusMask) forbidden.push(effective.sinusMask);

  if (forbidden.length === 0) return false;

  const { visited } = traverseRay(grid, candidate.entry, candidate.direction, candidate.length);

  for (const [ix, iy, iz] of visited) {
    for (const mask of forbidden) {
      if (mask.data[gridIndex(mask, ix, iy, iz)] === 1) return true;
    }
  }

  return false;
}

// ─── distance helpers ───────────────────────────────────────────────

/**
 * Minimum distance from a set of visited voxels to the nearest set
 * voxel in a mask.  If a precomputed distance field is provided, it
 * is sampled directly; otherwise a brute-force lookup is used.
 */
function minDistanceToMask(
  grid: VoxelGrid,
  visited: [number, number, number][],
  mask: VoxelGrid | null,
  distField: Float32Array | null,
): number {
  if (!mask) return Infinity;

  if (distField) {
    let best = Infinity;
    for (const [ix, iy, iz] of visited) {
      const d = distField[gridIndex(mask, ix, iy, iz)];
      if (d < best) best = d;
    }
    return best;
  }

  // Brute-force fallback: collect all mask voxels, find nearest to any visited
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

  let best = Infinity;
  for (const [vx, vy, vz] of visited) {
    const wp = gridToWorld(grid, vx, vy, vz);
    for (const mp of maskPts) {
      const d = wp.distanceTo(mp);
      if (d < best) best = d;
    }
  }
  return best;
}

// ─── scoring ────────────────────────────────────────────────────────

export interface EvaluatorInput {
  masks: VoxelMasks;
  coefficients?: ScoringCoefficients;
  /** Pre-computed distance fields (optional, keyed by structure). */
  distanceFields?: DistanceFieldSet;
  /**
   * Total number of hematoma voxels across the full mask.
   * Used to normalise V_H(T) → [0, 1].  If omitted it is computed
   * on the fly (slightly slower when scoring many candidates).
   */
  hematomaVoxelCount?: number;
  /**
   * Optional dilated obstacle masks.  When provided, hard-constraint
   * checking uses these expanded regions to approximate a corridor
   * safety radius without explicit cylinder geometry.
   */
  dilatedMasks?: VoxelMasks;
}

/**
 * Score a single trajectory that has already passed hard-constraint
 * filtering.  Returns a fully-populated ScoredTrajectory with
 * explicit hit points and a normalised score breakdown.
 */
export function scoreTrajectory(
  candidate: TrajectoryCandidate,
  input: EvaluatorInput,
): ScoredTrajectory {
  const {
    masks,
    coefficients = DEFAULT_COEFFICIENTS,
    distanceFields,
  } = input;

  const grid = masks.hematomaMask;
  const { visited } = traverseRay(grid, candidate.entry, candidate.direction, candidate.length);

  // ── V_H(T): hematoma voxels traversed ────────────────────────────
  let voxelsInHematoma = 0;
  let firstHemaIdx = -1;
  for (let i = 0; i < visited.length; i++) {
    const [ix, iy, iz] = visited[i];
    if (grid.data[gridIndex(grid, ix, iy, iz)] === 1) {
      voxelsInHematoma++;
      if (firstHemaIdx < 0) firstHemaIdx = i;
    }
  }

  // ── Hit points ───────────────────────────────────────────────────
  const firstHematomaHit = firstHemaIdx >= 0
    ? gridToWorld(grid, ...visited[firstHemaIdx])
    : null;

  const hitPoints: TrajectoryHitPoints = {
    skinEntry: candidate.entry.clone(),
    firstHematomaHit,
  };

  // ── D_skin_to_hema (explicit, in mm) ─────────────────────────────
  const distSkinToHematoma = firstHematomaHit
    ? candidate.entry.distanceTo(firstHematomaHit)
    : candidate.length;

  // ── Proximity distances ──────────────────────────────────────────
  const dVessel = minDistanceToMask(
    grid, visited,
    masks.vesselMask,
    distanceFields?.vessel ?? null,
  );
  const dVent = minDistanceToMask(
    grid, visited,
    masks.ventricleMask,
    distanceFields?.ventricle ?? null,
  );
  const dSinus = minDistanceToMask(
    grid, visited,
    masks.sinusMask,
    distanceFields?.sinus ?? null,
  );

  // ── Raw terms ────────────────────────────────────────────────────
  const proximityRaw =
    coefficients.wVessel / (dVessel + EPS) +
    coefficients.wVent / (dVent + EPS) +
    coefficients.wSinus / (dSinus + EPS);

  // ── Normalisation (see module docstring for strategy) ────────────
  const hemaTotal = input.hematomaVoxelCount ?? countSetVoxels(grid);
  const vhNorm = hemaTotal > 0 ? voxelsInHematoma / hemaTotal : 0;
  const dSkinNorm = candidate.length > 0
    ? distSkinToHematoma / candidate.length
    : 1;
  const proximityNorm = 1 - Math.exp(-proximityRaw);

  // ── Final score (all terms in [0,1]) ─────────────────────────────
  const score =
    coefficients.alpha * vhNorm -
    coefficients.beta * dSkinNorm -
    coefficients.gamma * proximityNorm;

  const scoreBreakdown: ScoreBreakdown = {
    vhRaw: voxelsInHematoma,
    vhNorm,
    dSkinRaw: distSkinToHematoma,
    dSkinNorm,
    proximityRaw,
    proximityNorm,
    dVessel,
    dVent,
    dSinus,
  };

  return {
    ...candidate,
    score,
    voxelsInHematoma,
    distSkinToHematoma,
    proximityPenalty: proximityRaw,
    hitPoints,
    scoreBreakdown,
    meta: { dVessel, dVent, dSinus },
  };
}

// ─── internal helpers ───────────────────────────────────────────────

function countSetVoxels(grid: VoxelGrid): number {
  let n = 0;
  for (let i = 0; i < grid.data.length; i++) {
    if (grid.data[i] === 1) n++;
  }
  return n;
}
