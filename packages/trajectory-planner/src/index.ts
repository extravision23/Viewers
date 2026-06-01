/**
 * Barrel export for the voxel-based trajectory planning pipeline.
 */

export type { MeshRole, ObstacleSubtype } from './roles';
export {
  OBSTACLE_SUBTYPES,
  inferObstacleSubtype,
  inferMeshRoleFromLabel,
} from './roles';

export type {
  VoxelGrid,
  VoxelMasks,
  VoxelizeResult,
  MaskStats,
  PCAResult,
  PCAAnisotropy,
  TrajectoryCandidate,
  ScoredTrajectory,
  TrajectoryHitPoints,
  ScoreBreakdown,
  ScoringCoefficients,
  ComparisonMetrics,
  DistanceField,
  DistanceFieldSet,
  GeneratorConfig,
  OptimizerConfig,
} from './types';

export {
  DEFAULT_COEFFICIENTS,
  DEFAULT_GENERATOR_CONFIG,
  DEFAULT_OPTIMIZER_CONFIG,
} from './types';

export {
  voxelizeScene,
  createEmptyGrid,
  computeDistanceField,
  dilateMask,
  computeMaskStats,
  gridIndex,
  gridToWorld,
  worldToGrid,
  type ObstacleGroups,
} from './voxel/Voxelizer';
export { analyzePCA, collectOccupiedVoxels } from './geometry/PCAAnalyzer';
export { generateCandidates } from './planner/TrajectoryGenerator';
export { violatesHardConstraints, scoreTrajectory } from './planner/TrajectoryEvaluator';
export { optimizeTrajectories, type OptimizationResult, type OptimizeInput } from './planner/TrajectoryOptimizer';
export { computeMetrics } from './evaluation/TrajectoryMetrics';
export { computeLoss, averageLoss, DEFAULT_LOSS_WEIGHTS } from './evaluation/LossFunction';
export { tuneCoefficients, type TuningCase, type TunerResult } from './optimization/CoefficientTuner';

// debug / observability
export { buildDebugReport, formatDebugReport, type PlannerDebugReport, type CandidateSummary } from './debug/PlannerDebugReport';
export { validateSafety, formatValidationReport, type ValidationReport, type Violation } from './debug/SafetyValidator';
export { runBatchEvaluation, batchResultToJson, type EvalCase, type CaseResult, type BatchResult, type BatchSummary } from './debug/BatchEvaluator';
export { buildTuningReadiness, formatTuningReadiness, type TuningReadinessReport } from './debug/TuningReadinessReport';
export { buildOverlay, disposeOverlay, type OverlayOptions } from './debug/DebugOverlay';

export { buildBVH, collectMeshes, generateMeshId } from './mesh/bvh';

// experiments
export {
  buildExperimentMeta,
  computeRunId,
  snapshotConfig,
  configFromSnapshot,
  type ExperimentMeta,
  type ConfigSnapshot,
} from './experiments/ExperimentMetadata';
export {
  runBaselineExperiment,
  type BaselineInput,
  type BaselineExperimentResult,
} from './experiments/BaselineExperimentRunner';
export {
  runSensitivitySweeps,
  defaultSweepSpecs,
  type SweepInput,
  type SweepParam,
  type SweepParamSpec,
  type SweepPointMetrics,
  type ParamSweepResult,
  type SweepResult,
} from './experiments/SensitivitySweep';
export {
  scoreExperiment,
  formatExperimentScore,
  type CaseRanking,
  type ExperimentScore,
} from './experiments/ExperimentScorer';
