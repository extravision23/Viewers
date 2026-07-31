import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DEFAULT_OPTIMIZER_CONFIG,
  optimizeTrajectories,
  type MeshRole,
  type ObstacleSubtype,
  type OptimizerConfig,
} from '@extravision/trajectory-planner';
import { RoleManager } from './planner/RoleManager';
import { TrajectoryTool } from './planner/TrajectoryTool';
import { validateTrajectory } from './planner/CollisionSolver';
import { ComparisonRenderer } from './planner/ComparisonRenderer';
import {
  buildVoxelCache,
  evaluateManualTrajectory,
  buildRecommendations,
  type VoxelCache,
} from './planner/ManualTrajectoryEvaluator';
import {
  createEmptyWorkflowState,
  DEFAULT_ADVANCED_CONFIG,
  QUALITY_PRESETS,
  type AdvancedConfig,
  type PlanningWorkflowState,
  type TrajectoryReference,
  type PlannerQuality,
} from './planner/WorkflowTypes';
import type { LoadedSegmentMesh } from './utils/loadSegmentMeshes';
import { yieldToMain } from './utils/yieldToMain';

export type SceneMode = 'ROLES' | 'TRAJECTORY';

export type WorkflowListener = (state: PlanningWorkflowState) => void;

function serializeTrajectoryRef(ref: TrajectoryReference | null) {
  if (!ref) {
    return null;
  }
  return {
    kind: ref.kind,
    entry: [ref.entry.x, ref.entry.y, ref.entry.z],
    direction: [ref.direction.x, ref.direction.y, ref.direction.z],
    length: ref.length,
    corridorRadius: ref.corridorRadius,
    isValid: ref.isValid,
    invalidReason: ref.invalidReason,
    metrics: ref.metrics,
  };
}

export class TrajectorySceneController {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private roleManager = new RoleManager();
  private trajectoryTool: TrajectoryTool | null = null;
  private comparisonRenderer: ComparisonRenderer | null = null;
  private mode: SceneMode = 'ROLES';
  private isShiftDown = false;
  private workflowState: PlanningWorkflowState = createEmptyWorkflowState();
  private advancedConfig: AdvancedConfig = { ...DEFAULT_ADVANCED_CONFIG };
  private voxelCache: VoxelCache | null = null;
  private voxelCacheSpacing: number | null = null;
  private meshRoot: THREE.Group | null = null;
  private onWorkflowChange: WorkflowListener | null = null;
  private animationId: number | null = null;
  private disposed = false;

  constructor(private mountEl: HTMLElement) {
    const width = Math.max(mountEl.clientWidth, 320);
    const height = Math.max(mountEl.clientHeight, 280);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1419);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
    this.camera.position.set(200, 150, 200);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mountEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(100, 200, 100);
    this.scene.add(dir);

    this.bindInput();
    this.animate();
  }

  setWorkflowListener(listener: WorkflowListener): void {
    this.onWorkflowChange = listener;
    listener(this.workflowState);
  }

  getRoleManager(): RoleManager {
    return this.roleManager;
  }

  getWorkflowState(): PlanningWorkflowState {
    return { ...this.workflowState };
  }

  getAdvancedConfig(): AdvancedConfig {
    return { ...this.advancedConfig };
  }

  setAdvancedConfig(config: AdvancedConfig): void {
    this.advancedConfig = { ...config };
  }

  setPlannerQuality(quality: PlannerQuality): void {
    this.workflowState.plannerQuality = quality;
    const preset = QUALITY_PRESETS[quality];
    this.advancedConfig = { ...this.advancedConfig, ...preset };
    this.emitWorkflow();
  }

  getMode(): SceneMode {
    return this.mode;
  }

  async loadSegments(segments: LoadedSegmentMesh[]): Promise<void> {
    if (this.meshRoot) {
      this.scene.remove(this.meshRoot);
    }
    this.roleManager.reset();
    this.meshRoot = new THREE.Group();
    segments.forEach(seg => {
      this.meshRoot!.add(seg.mesh);
      this.roleManager.registerMesh(seg.id, seg.label, seg.mesh, seg.defaultRole);
    });
    this.scene.add(this.meshRoot);

    const box = new THREE.Box3().setFromObject(this.meshRoot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 1);
    const distance = maxSize * 2.2;
    this.camera.position.set(center.x + distance, center.y + distance * 0.4, center.z + distance);
    this.controls.target.copy(center);
    this.controls.update();

    if (!this.trajectoryTool) {
      this.trajectoryTool = new TrajectoryTool(this.scene, center.y, this.renderer);
      this.trajectoryTool.onTrajectoryChanged = () => {
        this.validateTrajectory();
        this.emitWorkflow();
      };
    }

    const target = this.roleManager.getTargetMesh();
    if (target) {
      const targetCenter = new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3());
      this.trajectoryTool.setTargetCenter(targetCenter);
      this.trajectoryTool.setEntrySurfaceMeshes(this.roleManager.getMeshesByRole('ENTRY_SURFACE'));
      this.trajectoryTool.setObstacleMeshes(this.roleManager.getMeshesByRole('OBSTACLE'));
    }

    this.emitWorkflow();
  }

  enterTrajectoryMode(): void {
    if (!this.roleManager.getTargetMesh() || !this.roleManager.getEntrySurfaceMesh()) {
      throw new Error('Assign TARGET and ENTRY_SURFACE roles before planning.');
    }
    this.mode = 'TRAJECTORY';
    this.controls.enabled = true;
    const target = this.roleManager.getTargetMesh()!;
    const targetCenter = new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3());
    const entryMeshes = this.roleManager.getMeshesByRole('ENTRY_SURFACE');
    if (this.trajectoryTool) {
      this.trajectoryTool.setTargetCenter(targetCenter);
      this.trajectoryTool.setEntrySurfaceMeshes(entryMeshes);
      this.trajectoryTool.setObstacleMeshes(this.roleManager.getMeshesByRole('OBSTACLE'));
      // Entry must be on the OUTER surface of ENTRY_SURFACE (raycast from outside),
      // never the mesh AABB center — that puts the tip inside the skull/scalp volume.
      const placed = this.placeInitialEntryOnSurface(targetCenter, entryMeshes);
      if (!placed) {
        throw new Error(
          'Could not find an entry point on ENTRY_SURFACE. Check that the entry mesh is a closed outer surface.'
        );
      }
      this.validateTrajectory();
    }
    this.emitWorkflow();
  }

  /**
   * Raycast from outside the scene toward the target; first hit on ENTRY_SURFACE
   * is the entry point (same approach as trajectory_tool EntryPointResolver).
   */
  private placeInitialEntryOnSurface(
    targetCenter: THREE.Vector3,
    entryMeshes: THREE.Mesh[]
  ): boolean {
    if (!this.trajectoryTool || !entryMeshes.length) {
      return false;
    }

    const sceneBounds = this.meshRoot
      ? new THREE.Box3().setFromObject(this.meshRoot)
      : new THREE.Box3().setFromObject(this.scene);
    const sceneDiagonal = Math.max(sceneBounds.getSize(new THREE.Vector3()).length(), 1);
    const rayStartDistance = sceneDiagonal * 1.2;

    // Prefer the side of the entry mesh relative to the target (hint only for approach).
    const entryHint = new THREE.Box3().setFromObject(entryMeshes[0]).getCenter(new THREE.Vector3());
    const preferredOutward = new THREE.Vector3().subVectors(entryHint, targetCenter);
    if (preferredOutward.lengthSq() < 1e-6) {
      preferredOutward.set(0, 0, 1);
    }
    preferredOutward.normalize();

    const tryDirections: THREE.Vector3[] = [preferredOutward];
    // Fibonacci-ish fallbacks if the preferred side misses (thin / open mesh).
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < 24; i++) {
      const y = 1 - (i / 23) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      tryDirections.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize());
    }

    const raycaster = new THREE.Raycaster();
    raycaster.far = sceneDiagonal * 3;

    for (const outward of tryDirections) {
      const rayOrigin = targetCenter.clone().addScaledVector(outward, rayStartDistance);
      const rayDir = new THREE.Vector3().subVectors(targetCenter, rayOrigin).normalize();
      raycaster.set(rayOrigin, rayDir);
      const hits = raycaster.intersectObjects(entryMeshes, false);
      if (!hits.length) {
        continue;
      }

      const entryPoint = hits[0].point.clone();
      const direction = new THREE.Vector3().subVectors(targetCenter, entryPoint);
      if (direction.lengthSq() < 1e-6) {
        continue;
      }
      direction.normalize();

      this.trajectoryTool.setFromCandidate({
        entryPoint,
        direction,
        length: entryPoint.distanceTo(targetCenter) + 20,
      });
      return true;
    }

    return false;
  }

  async saveManualTrajectory(): Promise<void> {
    if (!this.trajectoryTool || this.workflowState.isSavingManual) {
      return;
    }
    const st = this.trajectoryTool.state;
    this.workflowState.isSavingManual = true;
    this.emitWorkflow();

    const entry = st.basePoint.clone();
    const direction = st.direction.clone().normalize();
    const length = st.maxLength;
    const corridorRadius = st.corridorRadius;
    const meshesByRole = this.buildMeshesByRole();

    let metrics = null;
    try {
      await yieldToMain();
      const spacing = this.advancedConfig.spacing;
      if (!this.voxelCache || this.voxelCacheSpacing !== spacing) {
        this.voxelCache = buildVoxelCache(meshesByRole, spacing, this.buildObstacleSubtypeGroups());
        this.voxelCacheSpacing = spacing;
      }
      metrics = evaluateManualTrajectory(entry, direction, length, this.voxelCache, {
        coefficients: {
          alpha: this.advancedConfig.alpha,
          beta: this.advancedConfig.beta,
          gamma: this.advancedConfig.gamma,
          delta: this.advancedConfig.delta,
          wVessel: this.advancedConfig.wVessel,
          wVent: this.advancedConfig.wVent,
          wSinus: this.advancedConfig.wSinus,
        },
      });
    } catch (err) {
      console.warn('[Trajectory] Manual evaluation failed', err);
    }

    const isValid = st.validationResult?.isValid ?? false;
    const ref: TrajectoryReference = {
      kind: 'manual',
      entry,
      direction,
      length,
      corridorRadius,
      isValid,
      invalidReason: isValid ? undefined : st.validationResult?.reason,
      metrics,
    };

    this.workflowState.savedManualTrajectory = ref;
    this.workflowState.aiSuggestedTrajectory = null;
    this.workflowState.comparison = null;
    this.workflowState.isSavingManual = false;

    if (!this.comparisonRenderer) {
      this.comparisonRenderer = new ComparisonRenderer(this.scene);
    }
    this.comparisonRenderer.setManualTrajectory(entry, direction, length);
    this.comparisonRenderer.clearAi();
    this.emitWorkflow();
  }

  async generateAiSuggestion(): Promise<void> {
    if (!this.workflowState.savedManualTrajectory || this.workflowState.isGeneratingAi) {
      return;
    }
    const entrySurfaceMeshes = this.roleManager.getMeshesByRole('ENTRY_SURFACE');
    const targetMesh = this.roleManager.getTargetMesh();
    if (!entrySurfaceMeshes.length || !targetMesh) {
      return;
    }

    this.workflowState.isGeneratingAi = true;
    this.emitWorkflow();

    try {
      if (this.mode !== 'TRAJECTORY') {
        this.enterTrajectoryMode();
      }

      const cfg: Partial<OptimizerConfig> = {
        spacing: this.advancedConfig.spacing,
        topK: this.advancedConfig.topK,
        dilationRadiusMm: this.advancedConfig.dilationRadiusMm,
        generator: {
          coneHalfAngleDeg: this.advancedConfig.coneHalfAngleDeg,
          samplesPerCone: this.advancedConfig.samplesPerCone,
        },
        coefficients: {
          alpha: this.advancedConfig.alpha,
          beta: this.advancedConfig.beta,
          gamma: this.advancedConfig.gamma,
          delta: this.advancedConfig.delta,
          wVessel: this.advancedConfig.wVessel,
          wVent: this.advancedConfig.wVent,
          wSinus: this.advancedConfig.wSinus,
        },
      };

      await yieldToMain();
      const result = optimizeTrajectories({
        meshesByRole: this.buildMeshesByRole(),
        maxLength: 350,
        obstacleGroups: this.buildObstacleSubtypeGroups(),
        config: { ...DEFAULT_OPTIMIZER_CONFIG, ...cfg } as OptimizerConfig,
      });

      if (result.trajectories.length > 0) {
        const best = result.trajectories[0];
        const bd = best.scoreBreakdown;
        const aiMetrics = {
          vesselClearanceMm: Number.isFinite(bd.dVessel) ? bd.dVessel : null,
          ventricleClearanceMm: Number.isFinite(bd.dVent) ? bd.dVent : null,
          sinusClearanceMm: Number.isFinite(bd.dSinus) ? bd.dSinus : null,
          intralesionalCoverage: Number.isFinite(bd.vhNorm) ? bd.vhNorm * 100 : null,
          extracerebralPathMm: Number.isFinite(bd.dSkinRaw) ? bd.dSkinRaw : null,
        };

        const aiRef: TrajectoryReference = {
          kind: 'ai',
          entry: best.entry.clone(),
          direction: best.direction.clone(),
          length: best.length,
          corridorRadius: this.trajectoryTool?.state.corridorRadius ?? 2,
          isValid: true,
          metrics: aiMetrics,
        };

        this.workflowState.aiSuggestedTrajectory = aiRef;
        const manual = this.workflowState.savedManualTrajectory;
        const angDiff =
          manual != null
            ? (Math.acos(Math.min(1, Math.abs(manual.direction.dot(aiRef.direction)))) * 180) / Math.PI
            : null;
        const entryShift = manual ? manual.entry.distanceTo(aiRef.entry) : null;

        this.workflowState.comparison = {
          angularDifferenceDeg: angDiff,
          entryShiftMm: entryShift,
          recommendations: buildRecommendations(manual?.metrics ?? null, aiMetrics),
        };

        if (!this.comparisonRenderer) {
          this.comparisonRenderer = new ComparisonRenderer(this.scene);
        }
        this.comparisonRenderer.setAiTrajectory(best.entry, best.direction, best.length);

        this.trajectoryTool?.setFromCandidate({
          entryPoint: best.entry,
          direction: best.direction,
          length: best.length + 4,
        });
        this.validateTrajectory();
      } else {
        this.workflowState.aiSuggestedTrajectory = null;
        this.workflowState.comparison = {
          angularDifferenceDeg: null,
          entryShiftMm: null,
          recommendations: ['No safe AI trajectory found. Adjust obstacle roles or parameters.'],
        };
      }
    } finally {
      this.workflowState.isGeneratingAi = false;
      this.emitWorkflow();
    }
  }

  resetComparison(): void {
    this.workflowState.savedManualTrajectory = null;
    this.workflowState.aiSuggestedTrajectory = null;
    this.workflowState.comparison = null;
    this.comparisonRenderer?.clearAll();
    this.emitWorkflow();
  }

  exportTrajectoryJson(meta: { segmentationId?: string; studyInstanceUID?: string }): void {
    if (!this.trajectoryTool) {
      return;
    }
    const state = this.trajectoryTool.state;
    const targetMesh = this.roleManager.getTargetMesh();
    if (!targetMesh) {
      return;
    }
    const targetCenter = new THREE.Box3().setFromObject(targetMesh).getCenter(new THREE.Vector3());
    const renderedLength = state.validationResult?.hitDistance ?? state.maxLength;
    const validationResult = state.validationResult;

    const trajectoryData = {
      trajectoryId: crypto.randomUUID(),
      entryPoint: [state.basePoint.x, state.basePoint.y, state.basePoint.z],
      targetPoint: [targetCenter.x, targetCenter.y, targetCenter.z],
      direction: [state.direction.x, state.direction.y, state.direction.z],
      length_mm: renderedLength,
      corridorRadius_mm: state.corridorRadius,
      preset: 'OHIF',
      risk: {
        isValid: validationResult?.isValid ?? false,
        reason: validationResult?.reason ?? 'UNKNOWN',
        blockedBy: validationResult?.blockedBy
          ? validationResult.blockedBy.name || 'unknown'
          : null,
        collisionCount: validationResult?.collisionCount ?? 0,
      },
      coordinateSystem: 'LPS',
      createdAt: new Date().toISOString(),
      source: 'ExtraVision OHIF Trajectory Planner',
      ...meta,
      savedManual: serializeTrajectoryRef(this.workflowState.savedManualTrajectory),
      aiSuggestion: serializeTrajectoryRef(this.workflowState.aiSuggestedTrajectory),
      comparison: this.workflowState.comparison,
    };

    const blob = new Blob([JSON.stringify(trajectoryData, null, 2)], { type: 'application/json' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `trajectory_${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  dispose(): void {
    this.disposed = true;
    if (this.animationId != null) {
      cancelAnimationFrame(this.animationId);
    }
    this.comparisonRenderer?.dispose();
    this.trajectoryTool?.dispose?.();
    this.roleManager.reset();
    this.renderer.dispose();
    this.mountEl.removeChild(this.renderer.domElement);
  }

  private buildMeshesByRole(): Map<MeshRole, THREE.Mesh[]> {
    const map = new Map<MeshRole, THREE.Mesh[]>();
    map.set('ENTRY_SURFACE', this.roleManager.getMeshesByRole('ENTRY_SURFACE'));
    const target = this.roleManager.getTargetMesh();
    if (target) {
      map.set('TARGET', [target]);
    }
    map.set('OBSTACLE', this.roleManager.getMeshesByRole('OBSTACLE'));
    map.set('CONTEXT', this.roleManager.getMeshesByRole('CONTEXT'));
    return map;
  }

  private buildObstacleSubtypeGroups(): Record<ObstacleSubtype, THREE.Mesh[]> {
    return this.roleManager.getObstaclesBySubtype();
  }

  private validateTrajectory(): void {
    if (!this.trajectoryTool || !this.roleManager.getTargetMesh()) {
      return;
    }
    const state = this.trajectoryTool.state;
    const entrySurfaceMeshes = this.roleManager.getMeshesByRole('ENTRY_SURFACE');
    let isBaseOnEntrySurface = entrySurfaceMeshes.length === 0;
    if (!isBaseOnEntrySurface) {
      const directions = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
      ];
      for (const dir of directions) {
        this.raycaster.set(state.basePoint, dir);
        this.raycaster.far = 1;
        const hits = this.raycaster.intersectObjects(entrySurfaceMeshes, false);
        if (hits.length > 0 && hits[0].distance < 1) {
          isBaseOnEntrySurface = true;
          break;
        }
      }
    }

    const result = validateTrajectory({
      targetMeshes: [this.roleManager.getTargetMesh()!],
      obstacleMeshes: this.roleManager.getMeshesByRole('OBSTACLE'),
      entrySurfaceMeshes,
      contextMeshes: this.roleManager.getMeshesByRole('CONTEXT'),
      basePoint: state.basePoint,
      direction: state.direction,
      maxLength: state.maxLength,
      corridorBaseRadius: state.corridorRadius,
      safetyMargin: 0.5,
      tipMargin: 4,
      baseMargin: 1,
      sampleCount: 40,
      isBaseOnEntrySurface,
    });

    this.trajectoryTool.setValidationResult(result);
    if (result.blockedBy) {
      this.roleManager.pulseObstacle(result.blockedBy);
    }
  }

  private emitWorkflow(): void {
    this.onWorkflowChange?.({ ...this.workflowState });
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => {
      if (e.key === 'Shift') {
        this.isShiftDown = true;
      }
    });
    window.addEventListener('keyup', e => {
      if (e.key === 'Shift') {
        this.isShiftDown = false;
        this.controls.enabled = true;
      }
    });
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.mode !== 'TRAJECTORY' || !this.isShiftDown || !this.trajectoryTool) {
      return;
    }
    this.controls.enabled = false;
    this.trajectoryTool.handleMouseDown(event as unknown as MouseEvent, event.altKey);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.mode !== 'TRAJECTORY' || !this.isShiftDown || !this.trajectoryTool) {
      return;
    }
    this.controls.enabled = false;
    this.trajectoryTool.handleMouseMove(event as unknown as MouseEvent, this.camera, this.raycaster);
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.mode !== 'TRAJECTORY' || !this.trajectoryTool) {
      return;
    }
    this.trajectoryTool.handleMouseUp(event as unknown as MouseEvent);
    this.controls.enabled = !this.isShiftDown;
    this.validateTrajectory();
  }

  private onWheel(event: WheelEvent): void {
    if (this.mode !== 'TRAJECTORY' || !this.isShiftDown || !this.trajectoryTool) {
      return;
    }
    event.preventDefault();
    this.controls.enabled = false;
    this.trajectoryTool.handleWheel(event, event.shiftKey);
    this.validateTrajectory();
  }

  private animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.animationId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
