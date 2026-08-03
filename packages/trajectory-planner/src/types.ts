/**
 * Shared types for the voxel-based trajectory planning pipeline.
 */

import type * as THREE from 'three';

/** Dense 3-D binary/label grid aligned to a uniform axis-aligned lattice. */
export interface VoxelGrid {
  /** Flat row-major buffer: index = x + y*nx + z*nx*ny */
  data: Uint8Array;
  /** Grid dimensions [nx, ny, nz] */
  dims: [number, number, number];
  /** Isotropic voxel spacing in mm */
  spacing: number;
  /** World-space origin of voxel (0,0,0) */
  origin: THREE.Vector3;
}

/** Named masks produced by the Voxelizer. */
export interface VoxelMasks {
  hematomaMask: VoxelGrid;
  vesselMask: VoxelGrid | null;
  ventricleMask: VoxelGrid | null;
  sinusMask: VoxelGrid | null;
  brainMask: VoxelGrid | null;
}

/** Per-mask debug statistics exposed by the Voxelizer. */
export interface MaskStats {
  /** Number of set (=1) voxels. */
  voxelCount: number;
  /** Tight axis-aligned bounding box of set voxels (grid indices). */
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Fraction of the grid volume occupied by set voxels. */
  bboxCoverage: number;
  /** Estimated physical volume in mm³  (voxelCount × spacing³). */
  estimatedVolumeMm3: number;
}

/** Complete voxelization result: masks + per-mask diagnostics. */
export interface VoxelizeResult {
  masks: VoxelMasks;
  stats: {
    hematoma: MaskStats;
    vessel: MaskStats | null;
    ventricle: MaskStats | null;
    sinus: MaskStats | null;
    brain: MaskStats | null;
  };
}

/** PCA decomposition result for a point cloud. */
export interface PCAResult {
  center: THREE.Vector3;
  principalAxis: THREE.Vector3;
  eigenValues: [number, number, number];
  /** Anisotropy / confidence ratios derived from eigenvalues. */
  anisotropy: PCAAnisotropy;
}

/**
 * Anisotropy metrics quantify how elongated the hematoma is along the
 * principal axis and whether the PCA decomposition is trustworthy.
 *
 * - `elongation` (λ1/λ2): large → strongly elongated along PC1.
 * - `flatness`   (λ2/λ3): large → planar (disc-like) rather than prolate.
 * - `spread`     (λ1/λ3): overall shape spread; large → highly anisotropic.
 * - `isStable`: true when the principal axis is well-separated from the
 *   second component (elongation ≥ threshold).  An unstable axis means
 *   the hematoma is roughly spherical and cone direction is arbitrary.
 */
export interface PCAAnisotropy {
  elongation: number;
  flatness: number;
  spread: number;
  isStable: boolean;
}

/** A single candidate trajectory before scoring. */
export interface TrajectoryCandidate {
  entry: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
}

/** Key points resolved along the trajectory during evaluation. */
export interface TrajectoryHitPoints {
  /** The skin/scalp entry point (= candidate.entry). */
  skinEntry: THREE.Vector3;
  /**
   * First voxel of the hematoma mask hit along the ray, or null if
   * the trajectory never enters the hematoma.
   */
  firstHematomaHit: THREE.Vector3 | null;
}

/** Scored trajectory (after evaluation). */
export interface ScoredTrajectory extends TrajectoryCandidate {
  score: number;
  voxelsInHematoma: number;
  distSkinToHematoma: number;
  proximityPenalty: number;
  /** Resolved geometry landmarks along the trajectory. */
  hitPoints: TrajectoryHitPoints;
  /**
   * Raw (un-normalised) term values and the normalised components
   * that were combined into `score`.  Useful for debugging &
   * calibration.
   */
  scoreBreakdown: ScoreBreakdown;
  meta?: Record<string, number>;
}

/**
 * Breakdown of every score term, both raw and normalised.
 *
 * Normalisation strategy (documented here, implemented in evaluator):
 *
 *   V_H_norm       = V_H / hematomaVoxelCount                 ∈ [0, 1]
 *   D_skin_norm    = min(1, D_skin_to_hema / SKIN_REF_MM)     ∈ [0, 1]
 *   L_norm         = min(1, trajectoryLength / LENGTH_REF_MM) ∈ [0, 1]
 *   P_norm         = 1 − exp(−P_raw)                          ∈ [0, 1)
 *
 * The final score is:
 *   score = α·V_H_norm − β·D_skin_norm − γ·P_norm − δ·L_norm − ε·A_norm
 *
 * Absolute (mm) normalisation for path terms — not D_skin/length —
 * so short extracerebral approaches are preferred over long through-
 * lesion detours that only look "efficient" as a fraction.
 *
 * A_norm = 1 − |dir · PC1|  (0 = aligned with pathology axis).
 */
export interface ScoreBreakdown {
  vhRaw: number;
  vhNorm: number;
  dSkinRaw: number;
  dSkinNorm: number;
  lengthRaw: number;
  lengthNorm: number;
  proximityRaw: number;
  proximityNorm: number;
  angleRaw: number;
  angleNorm: number;
  dVessel: number;
  dVent: number;
  dSinus: number;
}

/** Reference distances (mm) used to map path lengths into [0, 1]. */
export const SKIN_DISTANCE_REF_MM = 100;
/** Softer length scale so paths beyond ~150 mm still incur cost. */
export const TRAJECTORY_LENGTH_REF_MM = 200;

/** Weights for the scoring function. */
export interface ScoringCoefficients {
  alpha: number;   // weight for hematoma coverage (keep low for access planning)
  beta: number;    // weight for absolute skin-to-hematoma distance
  gamma: number;   // weight for proximity penalty
  delta: number;   // weight for absolute trajectory length
  /** Soft penalty for deviation from pathology principal axis. */
  epsilon: number;

  wVessel: number; // proximity sub-weight: vessels
  wVent: number;   // proximity sub-weight: ventricles
  wSinus: number;  // proximity sub-weight: sinuses
}

/**
 * Default scoring — access-oriented: short path + clearance + PCA
 * alignment dominate; coverage is a weak secondary signal.
 */
export const DEFAULT_COEFFICIENTS: ScoringCoefficients = {
  alpha: 0.2,
  beta: 1.5,
  gamma: 0.9,
  delta: 1.4,
  epsilon: 0.45,
  wVessel: 1.0,
  wVent: 0.8,
  wSinus: 0.6,
};

/** Gradient-descent access optimizer settings. */
export interface GradientDescentConfig {
  /** Max GD iterations per multi-start seed. */
  maxIterations: number;
  /** Step size for (θ, φ) updates (radians). */
  learningRate: number;
  /** Finite-difference epsilon (radians). */
  fdEpsilon: number;
  /** How many shortest full-sphere entries to use as ipsilateral seeds. */
  ipsilateralSeedCount: number;
  /** Full-sphere samples used to discover short ipsilateral entries. */
  sphereSeedSamples: number;
  /** Max multi-start seeds (PCA ± ipsilateral ± cone survivors). */
  maxStarts: number;
}

export const DEFAULT_GRADIENT_CONFIG: GradientDescentConfig = {
  maxIterations: 35,
  learningRate: 0.04,
  fdEpsilon: 0.012,
  ipsilateralSeedCount: 8,
  sphereSeedSamples: 96,
  maxStarts: 14,
};

/** Comparison metrics between AI and expert trajectories. */
export interface ComparisonMetrics {
  angularDeviation: number;
  entryDistance: number;
  targetDistance: number;
  intralesionalLengthDiff: number;
  vesselMarginDiff: number;
  ventMarginDiff: number;
  sinusMarginDiff: number;
}

/**
 * Abstract distance field — a Float32Array holding distance-in-mm at
 * each voxel, indexed identically to VoxelGrid.data.
 *
 * The evaluator and metrics modules consume this type without caring
 * whether it was produced by an approximate BFS, an exact EDT (e.g.
 * Saito-Toriwaki / Felzenszwalb-Huttenlocher), or an SDF.
 *
 * To swap the implementation, replace the factory function that
 * produces these arrays — no evaluator changes required.
 */
export type DistanceField = Float32Array;

/**
 * Bundle of pre-computed distance fields keyed by obstacle role.
 * Passed into the evaluator / metrics to avoid recomputation.
 */
export interface DistanceFieldSet {
  vessel?: DistanceField | null;
  ventricle?: DistanceField | null;
  sinus?: DistanceField | null;
}

/** Configuration for the trajectory generator. */
export interface GeneratorConfig {
  coneHalfAngleDeg: number;
  samplesPerCone: number;
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  // Wider than the old 20° PCA cone so shorter scalp entries off-axis are considered.
  coneHalfAngleDeg: 35,
  samplesPerCone: 400,
};

/** Configuration for the full optimizer pipeline. */
export interface OptimizerConfig {
  generator: GeneratorConfig;
  coefficients: ScoringCoefficients;
  gradient: GradientDescentConfig;
  topK: number;
  spacing: number;
  /**
   * Optional binary dilation radius in mm applied to obstacle masks
   * (vessel, ventricle, sinus) before hard-constraint checking.
   * Approximates a safety corridor without explicit corridor geometry.
   * Set to 0 or omit to disable dilation.
   */
  dilationRadiusMm: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  generator: DEFAULT_GENERATOR_CONFIG,
  coefficients: DEFAULT_COEFFICIENTS,
  gradient: DEFAULT_GRADIENT_CONFIG,
  topK: 5,
  spacing: 1.0,
  dilationRadiusMm: 0,
};
