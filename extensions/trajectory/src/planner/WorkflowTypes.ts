/**
 * WorkflowTypes — shared types for the clinician-first planning
 * workflow: manual trajectory save, AI suggestion, side-by-side
 * comparison, and advanced configuration.
 */

import * as THREE from 'three';

export type SavedTrajectoryKind = 'manual' | 'ai';

/** Clinical metrics for a single trajectory (voxel-pipeline derived). */
export interface TrajectoryMetricsData {
  vesselClearanceMm: number | null;
  ventricleClearanceMm: number | null;
  sinusClearanceMm: number | null;
  /** Normalised intralesional fraction (V_H_norm), 0–100 %. */
  intralesionalCoverage: number | null;
  /** Distance from skin entry to first hematoma voxel (mm). */
  extracerebralPathMm: number | null;
}

/** Snapshot of a saved trajectory (manual or AI). */
export interface TrajectoryReference {
  kind: SavedTrajectoryKind;
  entry: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  corridorRadius: number;
  isValid: boolean;
  invalidReason?: string;
  metrics: TrajectoryMetricsData | null;
}

/** Side-by-side comparison between manual and AI trajectories. */
export interface ComparisonResult {
  angularDifferenceDeg: number | null;
  entryShiftMm: number | null;
  recommendations: string[];
}

/** Full planning workflow state driving the UI. */
export interface PlanningWorkflowState {
  savedManualTrajectory: TrajectoryReference | null;
  aiSuggestedTrajectory: TrajectoryReference | null;
  comparison: ComparisonResult | null;
  isGeneratingAi: boolean;
  isSavingManual: boolean;
  showAdvancedSettings: boolean;
  showDebugOverlay: boolean;
  plannerQuality: PlannerQuality;
}

/** Exposed planner parameters for the Advanced Settings panel. */
export interface AdvancedConfig {
  alpha: number;
  beta: number;
  gamma: number;
  delta: number;
  wVessel: number;
  wVent: number;
  wSinus: number;
  spacing: number;
  coneHalfAngleDeg: number;
  samplesPerCone: number;
  topK: number;
  dilationRadiusMm: number;
}

export type PlannerQuality = 'preview' | 'accurate';

/**
 * Preview: lightweight for responsive browser usage.
 * Accurate: higher-quality for research/export (may freeze for 2-5 s).
 */
export const QUALITY_PRESETS: Record<PlannerQuality, Partial<AdvancedConfig>> = {
  preview: {
    spacing: 2.0,
    samplesPerCone: 120,
    topK: 5,
    dilationRadiusMm: 0,
  },
  accurate: {
    spacing: 1.0,
    samplesPerCone: 500,
    topK: 10,
    dilationRadiusMm: 0,
  },
};

export const DEFAULT_ADVANCED_CONFIG: AdvancedConfig = {
  alpha: 0.8,
  beta: 1.2,
  gamma: 0.5,
  delta: 0.7,
  wVessel: 1.0,
  wVent: 0.8,
  wSinus: 0.6,
  spacing: 2.0,
  coneHalfAngleDeg: 35,
  samplesPerCone: 120,
  topK: 5,
  dilationRadiusMm: 0,
};

export function createEmptyWorkflowState(): PlanningWorkflowState {
  return {
    savedManualTrajectory: null,
    aiSuggestedTrajectory: null,
    comparison: null,
    isGeneratingAi: false,
    isSavingManual: false,
    showAdvancedSettings: false,
    showDebugOverlay: false,
    plannerQuality: 'preview',
  };
}

/** Context flags consumed by UI button-enable logic. */
export interface ButtonStateContext {
  hasScene: boolean;
  hasTarget: boolean;
  hasEntrySurface: boolean;
  isTrajectoryMode: boolean;
  hasTrajectory: boolean;
  hasSavedManual: boolean;
  hasAiSuggestion: boolean;
  isGeneratingAi: boolean;
  isSavingManual: boolean;
}
