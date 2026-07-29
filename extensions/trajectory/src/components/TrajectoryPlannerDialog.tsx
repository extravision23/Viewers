import React, { useEffect, useRef, useState } from 'react';
import { TrajectorySceneController } from '../TrajectorySceneController';
import type { SegmentMeshArtifact } from '../utils/loadSegmentMeshes';
import { loadSegmentMeshes } from '../utils/loadSegmentMeshes';
import SegmentRolePanel from './SegmentRolePanel';
import {
  createEmptyWorkflowState,
  type PlanningWorkflowState,
  type PlannerQuality,
} from '../planner/WorkflowTypes';

export type TrajectoryPlannerDialogProps = {
  hide?: () => void;
  models: SegmentMeshArtifact[];
  title?: string;
  segmentationId?: string;
  studyInstanceUID?: string;
};

export default function TrajectoryPlannerDialog({
  hide,
  models,
  title,
  segmentationId,
  studyInstanceUID,
}: TrajectoryPlannerDialogProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<TrajectorySceneController | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workflow, setWorkflow] = useState<PlanningWorkflowState>(createEmptyWorkflowState());
  const [mode, setMode] = useState<'ROLES' | 'TRAJECTORY'>('ROLES');
  const [roleTick, setRoleTick] = useState(0);
  const [plannerQuality, setPlannerQuality] = useState<PlannerQuality>('preview');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewportRef.current) {
      return;
    }

    const controller = new TrajectorySceneController(viewportRef.current);
    controllerRef.current = controller;
    controller.setWorkflowListener(setWorkflow);

    let cancelled = false;

    (async () => {
      try {
        const { segments } = await loadSegmentMeshes(models);
        if (cancelled) {
          return;
        }
        if (!segments.length) {
          setLoadError(
            'No segment meshes loaded — GLB files appear empty. Close this dialog, enable "No Cache", and open Trajectory Planner again.'
          );
          setLoading(false);
          return;
        }
        await controller.loadSegments(segments);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err?.message || 'Failed to load segment meshes');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.dispose();
      controllerRef.current = null;
    };
  }, [models]);

  const handlePlanTrajectory = () => {
    setActionError(null);
    try {
      controllerRef.current?.enterTrajectoryMode();
      setMode('TRAJECTORY');
    } catch (e) {
      setActionError(e?.message || 'Cannot start planning');
    }
  };

  const handleSaveManual = async () => {
    setActionError(null);
    await controllerRef.current?.saveManualTrajectory();
  };

  const handleGenerateAi = async () => {
    setActionError(null);
    controllerRef.current?.setPlannerQuality(plannerQuality);
    await controllerRef.current?.generateAiSuggestion();
  };

  const handleExport = () => {
    controllerRef.current?.exportTrajectoryJson({ segmentationId, studyInstanceUID });
  };

  void roleTick;
  const hasTarget = !!controllerRef.current?.getRoleManager().getTargetMesh();
  const hasEntry = !!controllerRef.current?.getRoleManager().getEntrySurfaceMesh();
  const canPlan = hasTarget && hasEntry && !loading;
  const canSaveManual = mode === 'TRAJECTORY' && !workflow.isSavingManual;
  const canGenerateAi = !!workflow.savedManualTrajectory && !workflow.isGeneratingAi;

  return (
    <div className="flex h-[min(85vh,820px)] w-[min(96vw,1200px)] flex-col gap-2 p-2 text-sm text-white">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
        <div>
          <h2 className="text-base font-semibold">Trajectory Planner</h2>
          {title ? <p className="text-muted-foreground text-xs">{title}</p> : null}
        </div>
        <button
          type="button"
          className="rounded border border-white/20 px-2 py-1 text-xs"
          onClick={() => hide?.()}
        >
          Close
        </button>
      </div>

      <p className="text-muted-foreground text-xs">
        Research/educational use only — not a certified medical device. Coordinates: LPS (mm).
      </p>

      {loadError ? (
        <p className="text-red-400 text-xs">{loadError}</p>
      ) : null}
      {actionError ? (
        <p className="text-red-400 text-xs">{actionError}</p>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto">
          <section>
            <h3 className="mb-1 font-medium">1. Assign roles</h3>
            {controllerRef.current ? (
              <SegmentRolePanel
                roleManager={controllerRef.current.getRoleManager()}
                onRolesChanged={() => {
                  setRoleTick(t => t + 1);
                  setWorkflow(controllerRef.current!.getWorkflowState());
                }}
              />
            ) : (
              <p className="text-muted-foreground text-xs">Loading…</p>
            )}
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="font-medium">2. Planning</h3>
            <button
              type="button"
              className="bg-primary text-primary-foreground disabled:opacity-50 rounded px-2 py-1 text-xs"
              disabled={!canPlan}
              onClick={handlePlanTrajectory}
            >
              Plan trajectory
            </button>
            <p className="text-muted-foreground text-[10px]">
              Hold <strong>Shift</strong> + drag to move entry; rotate direction; wheel adjusts
              corridor.
            </p>
            <button
              type="button"
              className="bg-primary text-primary-foreground disabled:opacity-50 rounded px-2 py-1 text-xs"
              disabled={!canSaveManual}
              onClick={handleSaveManual}
            >
              {workflow.isSavingManual ? 'Saving…' : 'Save manual trajectory'}
            </button>
            <label className="text-muted-foreground flex items-center gap-1 text-xs">
              Quality
              <select
                className="bg-background border-input rounded border px-1"
                value={plannerQuality}
                onChange={e => setPlannerQuality(e.target.value as PlannerQuality)}
              >
                <option value="preview">Preview</option>
                <option value="accurate">Accurate</option>
              </select>
            </label>
            <button
              type="button"
              className="bg-primary text-primary-foreground disabled:opacity-50 rounded px-2 py-1 text-xs"
              disabled={!canGenerateAi}
              onClick={handleGenerateAi}
            >
              {workflow.isGeneratingAi ? 'Generating AI…' : 'Generate AI suggestion'}
            </button>
            <button
              type="button"
              className="rounded border border-white/20 px-2 py-1 text-xs"
              onClick={() => controllerRef.current?.resetComparison()}
            >
              Reset comparison
            </button>
            <button
              type="button"
              className="rounded border border-white/20 px-2 py-1 text-xs"
              onClick={handleExport}
            >
              Export JSON
            </button>
          </section>

          {workflow.comparison ? (
            <section className="text-xs">
              <h3 className="mb-1 font-medium">Comparison</h3>
              {workflow.comparison.angularDifferenceDeg != null ? (
                <p>Angle diff: {workflow.comparison.angularDifferenceDeg.toFixed(1)}°</p>
              ) : null}
              {workflow.comparison.entryShiftMm != null ? (
                <p>Entry shift: {workflow.comparison.entryShiftMm.toFixed(1)} mm</p>
              ) : null}
              <ul className="mt-1 list-disc pl-4">
                {workflow.comparison.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="relative min-h-[320px] min-w-0 flex-1 rounded border border-white/10 bg-black">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs">
              Loading meshes…
            </div>
          ) : null}
          <div
            ref={viewportRef}
            className="h-full w-full"
          />
        </div>
      </div>
    </div>
  );
}
