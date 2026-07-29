/**
 * Trajectory Tool: visual representation and input handling
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ValidationResult } from './CollisionSolver';
type AutoCandidate = { basePoint: THREE.Vector3; direction: THREE.Vector3; length: number };

export interface TrajectoryState {
  basePoint: THREE.Vector3;
  direction: THREE.Vector3;
  corridorRadius: number;
  maxLength: number;
  validationResult: ValidationResult | null;
}

/**
 * STEP 1: Ownership type
 * Ownership determines who last set the trajectory (AUTO vs MANUAL)
 * This does NOT block input - it's just metadata
 */
type Ownership = 'AUTO' | 'MANUAL';

export class TrajectoryTool {
  public state: TrajectoryState;
  
  // STEP 1: Explicit ownership tracking
  private ownership: Ownership = 'MANUAL';
  
  // Manual override callback (for Game.ts to track ownership)
  public onManualOverride?: () => void;

  /** Fired whenever trajectory geometry changes (drag, rotate, set, etc.). */
  public onTrajectoryChanged?: () => void;

  /** True once the trajectory has been placed/edited away from default. */
  public dirty = false;
  
  // Visual elements
  private baseMarker: THREE.Mesh;
  private trajectoryLine: Line2;
  private centerAxisLine: Line2;
  private corridorCone: THREE.Mesh;
  private ghostMarker?: THREE.Mesh;
  private riskHeatmap?: THREE.Line; // Risk heatmap visualization
  private showHeatmap: boolean = false;
  
  // Scene references
  private scene: THREE.Scene;
  private placementPlaneY: number;
  private entrySurfaceMeshes: THREE.Mesh[] = [];
  private obstacleMeshes: THREE.Mesh[] = []; // For heatmap clearance computation
  private autoAim: boolean = true;
  private targetCenter: THREE.Vector3 | null = null;
  private recommendedMaxLength: number = 50.0;
  private heatmapUpdatePending: boolean = false; // Debounce heatmap updates
  
  // Input state
  private isDragging: boolean = false;
  private isRotating: boolean = false;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  
  // Materials
  private validMaterial: THREE.MeshBasicMaterial;
  private invalidMaterial: THREE.MeshBasicMaterial;
  private trajectoryLineMaterial: LineMaterial;
  private centerAxisMaterial: LineMaterial;
  
  private renderer: THREE.WebGLRenderer | null = null;
  
  constructor(scene: THREE.Scene, placementPlaneY: number, renderer?: THREE.WebGLRenderer) {
    this.scene = scene;
    this.placementPlaneY = placementPlaneY;
    if (renderer) this.renderer = renderer;
    
    // Initialize state
    this.state = {
      basePoint: new THREE.Vector3(0, placementPlaneY, 0),
      direction: new THREE.Vector3(1, 0, 0).normalize(),
      corridorRadius: 2.0,
      maxLength: 50.0,
      validationResult: null
    };
    
    // Create materials
    this.validMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    
    this.invalidMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    
    this.trajectoryLineMaterial = new LineMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.7,
      linewidth: 3,
      worldUnits: true,
      depthTest: false
    });
    
    this.centerAxisMaterial = new LineMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.4,
      linewidth: 2,
      dashed: true,
      dashSize: 3,
      gapSize: 2,
      worldUnits: true
    });
    
    // Create base marker
    this.baseMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    
    // Create trajectory line (Line2 for thick line support)
    const trajGeometry = new LineGeometry();
    trajGeometry.setPositions([0, 0, 0, 1, 0, 0]);
    this.trajectoryLine = new Line2(trajGeometry, this.trajectoryLineMaterial);
    this.trajectoryLine.renderOrder = 200; // Render on top
    
    // Create center axis (thick dashed line)
    const axisGeometry = new LineGeometry();
    axisGeometry.setPositions([0, 0, 0, 1, 0, 0]);
    this.centerAxisLine = new Line2(axisGeometry, this.centerAxisMaterial);
    this.centerAxisLine.renderOrder = 200; // On top, visible through transparent target
    
    // Create corridor cone
    const coneGeometry = new THREE.ConeGeometry(1, 1, 16);
    this.corridorCone = new THREE.Mesh(coneGeometry, this.invalidMaterial);
    this.corridorCone.renderOrder = 150;
    
    // Create ghost marker
    const ghostGeometry = new THREE.SphereGeometry(0.8, 12, 12);
    const ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0.3
    });
    this.ghostMarker = new THREE.Mesh(ghostGeometry, ghostMaterial);
    this.ghostMarker.visible = false;
    
    // Add to scene
    this.scene.add(this.baseMarker);
    this.scene.add(this.trajectoryLine);
    this.scene.add(this.centerAxisLine);
    this.scene.add(this.corridorCone);
    this.scene.add(this.ghostMarker);
    
    this.updateVisuals();
  }
  
  /**
   * Set entry surface meshes (base point can ONLY be placed on these)
   */
  public setEntrySurfaceMeshes(meshes: THREE.Mesh[]): void {
    this.entrySurfaceMeshes = meshes;
  }

  /** Obstacle meshes for heatmap clearance (optional). */
  public setObstacleMeshes(meshes: THREE.Mesh[]): void {
    this.obstacleMeshes = meshes;
  }

  /** @deprecated Use setObstacleMeshes */
  public setObstacles(meshes: THREE.Mesh[]): void {
    this.setObstacleMeshes(meshes);
  }
  
  /**
   * Set target center for auto-aim
   */
  public setTargetCenter(center: THREE.Vector3 | null): void {
    this.targetCenter = center;
    if (this.autoAim && center && this.entrySurfaceMeshes.length > 0) {
      // Auto-update direction when target center changes
      this.updateDirectionToTarget();
    }
  }
  
  /**
   * Enable/disable auto-aim
   */
  public setAutoAim(enabled: boolean): void {
    this.autoAim = enabled;
    if (enabled && this.targetCenter) {
      this.updateDirectionToTarget();
    }
  }
  
  /**
   * Update direction to point at target center
   */
  private updateDirectionToTarget(): void {
    if (this.targetCenter) {
      const dir = new THREE.Vector3()
        .subVectors(this.targetCenter, this.state.basePoint)
        .normalize();
      this.state.direction.copy(dir);
      
      // Recompute recommended maxLength when base point changes
      const distance = this.state.basePoint.distanceTo(this.targetCenter);
      const safetyMargin = 20.0; // mm
      const recommendedMaxLength = distance + safetyMargin;
      this.setRecommendedMaxLength(recommendedMaxLength);
      
      this.updateVisuals();
    }
  }
  
  /**
   * Update visual representation based on current state
   */
  public updateVisuals(): void {
    const { basePoint, direction, corridorRadius, maxLength, validationResult } = this.state;
    
    const isValid = validationResult?.isValid ?? false;
    const actualLength = validationResult?.hitDistance ?? maxLength;
    // When valid and target exists: extend cone and lines to target center (visible inside target)
    const extendToTargetCenter = isValid && !!this.targetCenter;
    const coneLength = extendToTargetCenter
      ? basePoint.distanceTo(this.targetCenter!)
      : actualLength;
    const lineEnd = extendToTargetCenter
      ? this.targetCenter!.clone()
      : basePoint.clone().add(direction.clone().multiplyScalar(actualLength));
    
    // Update base marker position
    this.baseMarker.position.copy(basePoint);
    
    // Update trajectory line (to target center when valid)
    (this.trajectoryLine.geometry as LineGeometry).setPositions([
      basePoint.x, basePoint.y, basePoint.z,
      lineEnd.x, lineEnd.y, lineEnd.z
    ]);
    if (this.renderer) {
      this.trajectoryLineMaterial.resolution.copy(this.renderer.getSize(new THREE.Vector2()));
    }
    this.trajectoryLineMaterial.color.setHex(isValid ? 0x00ff88 : 0xff4444);
    
    // Update corridor cone: extends to target center, visible inside target
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
    
    const visualRadius = corridorRadius * 3;
    this.corridorCone.scale.set(visualRadius, coneLength, visualRadius);
    this.corridorCone.quaternion.copy(quaternion);
    this.corridorCone.renderOrder = 150; // Above target (100) so cone is visible inside target
    
    const offset = direction.clone().multiplyScalar(coneLength * 0.5);
    this.corridorCone.position.copy(basePoint).add(offset);
    
    this.corridorCone.material = isValid ? this.validMaterial : this.invalidMaterial;
    
    // Update center axis (thick dashed line): full path from beyond entry to target center
    const extendBeyondEntry = 20;
    const axisStart = basePoint.clone().add(direction.clone().multiplyScalar(-extendBeyondEntry));
    const axisEnd = lineEnd.clone();
    (this.centerAxisLine.geometry as LineGeometry).setPositions([
      axisStart.x, axisStart.y, axisStart.z,
      axisEnd.x, axisEnd.y, axisEnd.z
    ]);
    if (this.renderer) {
      this.centerAxisMaterial.resolution.copy(this.renderer.getSize(new THREE.Vector2()));
    }
    this.centerAxisMaterial.color.setHex(isValid ? 0x00ff88 : 0xff4444);
    
    // Update heatmap if enabled
    if (this.showHeatmap) {
      this.updateHeatmap();
    }
  }
  
  /**
   * Update validation result and refresh visuals
   */
  public setValidationResult(result: ValidationResult | null): void {
    this.state.validationResult = result;
    this.updateVisuals();
  }
  
  /**
   * Set trajectory from auto-suggestion candidate
   * STEP 2: Full validation pipeline
   * This is the ONLY way AutoSuggest should set trajectory
   */
  public setFromAutoSuggestion(candidate: AutoCandidate | { basePoint: THREE.Vector3; direction: THREE.Vector3; length: number }): void {
    this.ownership = 'AUTO';
    this.state.basePoint.copy(candidate.basePoint);
    this.state.direction.copy(candidate.direction);
    this.state.maxLength = candidate.length;
    this.dirty = true;
    this.updateVisuals();
    if (this.showHeatmap) this.updateHeatmap();
    this.onTrajectoryChanged?.();
  }
  
  /**
   * Set trajectory from candidate (new planner interface)
   * Direction must point FROM entryPoint TO target
   */
  public setFromCandidate(candidate: { entryPoint: THREE.Vector3; direction: THREE.Vector3; length: number }): void {
    this.ownership = 'AUTO';
    const direction = candidate.direction.clone().normalize();
    this.state.basePoint.copy(candidate.entryPoint);
    this.state.direction.copy(direction);
    this.state.maxLength = candidate.length;
    this.dirty = true;
    this.updateVisuals();
    if (this.showHeatmap) this.updateHeatmap();
    this.onTrajectoryChanged?.();
  }
  
  /**
   * Apply direction from auto-suggest
   * Finds entry point using the same logic as manual placement
   * This ensures consistency between manual and auto placement
   */
  public applyDirection(direction: THREE.Vector3, targetCenter: THREE.Vector3, sceneBounds: THREE.Box3): boolean {
    if (this.entrySurfaceMeshes.length === 0) {
      return false;
    }
    
    // Find entry point by casting ray from outside scene along direction
    // This uses the same approach as EntryPointResolver but integrated here
    const sceneSize = sceneBounds.getSize(new THREE.Vector3());
    const sceneDiagonal = sceneSize.length();
    const rayStartDistance = sceneDiagonal * 1.2;
    
    // Ray origin: well outside the scene, in the direction from target
    const rayOrigin = new THREE.Vector3()
      .copy(targetCenter)
      .add(direction.clone().multiplyScalar(rayStartDistance));
    
    // Ray direction: towards target
    const rayDir = new THREE.Vector3()
      .subVectors(targetCenter, rayOrigin)
      .normalize();
    
    // Cast ray
    const raycaster = new THREE.Raycaster();
    raycaster.far = sceneDiagonal * 3;
    raycaster.set(rayOrigin, rayDir);
    
    // Intersect with ENTRY_SURFACE meshes
    const intersects = raycaster.intersectObjects(this.entrySurfaceMeshes, false);
    
    if (intersects.length > 0) {
      // Take FIRST intersection (outermost surface)
      const hit = intersects[0];
      const entryPoint = hit.point.clone();
      
      console.log("ENTRY via raycast", entryPoint);
      
      this.ownership = 'AUTO';
      this.state.basePoint.copy(entryPoint);
      this.state.direction.copy(direction);
      const distance = entryPoint.distanceTo(targetCenter);
      this.state.maxLength = distance + 20.0;
      this.dirty = true;
      this.updateVisuals();
      if (this.showHeatmap) this.updateHeatmap();
      this.onTrajectoryChanged?.();
      return true;
    }
    
    return false;
  }
  
  /**
   * Get current ownership
   */
  public getOwnership(): Ownership {
    return this.ownership;
  }
  
  /**
   * Toggle risk heatmap visualization
   */
  public toggleHeatmap(enabled: boolean): void {
    this.showHeatmap = enabled;
    if (enabled) {
      this.updateHeatmap();
    } else if (this.riskHeatmap) {
      this.riskHeatmap.visible = false;
    }
  }
  
  /**
   * Compute distance from point to obstacle mesh using BVH
   */
  private computeDistanceToObstacles(point: THREE.Vector3, maxDistance: number = 20.0): number {
    if (this.obstacleMeshes.length === 0) {
      return maxDistance; // No obstacles, assume safe
    }
    
    let minDistance = Infinity;
    const raycaster = new THREE.Raycaster();
    
    // Sample directions for distance estimation
    const directions = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1)
    ];
    
    for (const mesh of this.obstacleMeshes) {
      const geometry = mesh.geometry as any;
      
      // Try BVH closestPointToPoint if available
      if (geometry.boundsTree && geometry.boundsTree.closestPointToPoint) {
        const closestPoint = new THREE.Vector3();
        const distance = geometry.boundsTree.closestPointToPoint(point, closestPoint);
        if (distance < minDistance && distance < maxDistance) {
          minDistance = distance;
        }
      } else {
        // Fallback: use raycast in multiple directions
        for (const dir of directions) {
          raycaster.set(point, dir);
          raycaster.far = maxDistance;
          const intersects = raycaster.intersectObject(mesh, false);
          if (intersects.length > 0 && intersects[0].distance < minDistance) {
            minDistance = intersects[0].distance;
          }
        }
      }
    }
    
    return minDistance === Infinity ? maxDistance : minDistance;
  }
  
  /**
   * Update risk heatmap visualization with actual clearance data
   */
  private updateHeatmap(): void {
    // Debounce updates
    if (this.heatmapUpdatePending) return;
    this.heatmapUpdatePending = true;
    
    requestAnimationFrame(() => {
      this.heatmapUpdatePending = false;
      
      if (!this.showHeatmap || !this.state.validationResult?.isValid) {
        if (this.riskHeatmap) {
          this.riskHeatmap.visible = false;
        }
        return;
      }
      
      const basePoint = this.state.basePoint;
      const direction = this.state.direction;
      const actualLength = this.state.validationResult.hitDistance ?? this.state.maxLength;
      const tipPoint = basePoint.clone().add(direction.clone().multiplyScalar(actualLength));
      const corridorRadius = this.state.corridorRadius;
      
      // Create heatmap line with vertex colors
      const sampleCount = 60;
      const positions: number[] = [];
      const colors: number[] = [];
      
      for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const point = basePoint.clone().lerp(tipPoint, t);
        positions.push(point.x, point.y, point.z);
        
        // Compute local radius (linear taper)
        const localRadius = corridorRadius * (1 - t) + 0.001 * t;
        
        // Compute actual clearance to obstacles
        const distanceToObstacle = this.computeDistanceToObstacles(point, 20.0);
        const clearance = distanceToObstacle - localRadius - 0.5; // safety margin
        
        // Color mapping based on clearance
        // clearance < 2mm → RED
        // 2-4mm → ORANGE
        // 4-6mm → YELLOW
        // 6mm+ → GREEN
        let color: THREE.Color;
        if (clearance < 2.0) {
          color = new THREE.Color(1, 0, 0); // RED
        } else if (clearance < 4.0) {
          // Interpolate between red and orange
          const f = (clearance - 2.0) / 2.0;
          color = new THREE.Color(1, 0.5 * f, 0); // ORANGE
        } else if (clearance < 6.0) {
          // Interpolate between orange and yellow
          const f = (clearance - 4.0) / 2.0;
          color = new THREE.Color(1, 0.5 + 0.5 * f, 0); // YELLOW
        } else {
          color = new THREE.Color(0, 1, 0); // GREEN
        }
        
        colors.push(color.r, color.g, color.b);
      }
      
      // Create or update heatmap geometry
      if (!this.riskHeatmap) {
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({
          vertexColors: true,
          linewidth: 3,
          transparent: true,
          opacity: 0.8
        });
        
        this.riskHeatmap = new THREE.Line(geometry, material);
        this.riskHeatmap.renderOrder = 201; // Above trajectory line
        this.scene.add(this.riskHeatmap);
      }
      
      const geometry = this.riskHeatmap.geometry as THREE.BufferGeometry;
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      this.riskHeatmap.visible = true;
    });
  }
  
  private getMouseNdc(event: MouseEvent): THREE.Vector2 {
    const el = this.renderer?.domElement;
    if (el) {
      const rect = el.getBoundingClientRect();
      const w = Math.max(rect.width, 1);
      const h = Math.max(rect.height, 1);
      return new THREE.Vector2(
        ((event.clientX - rect.left) / w) * 2 - 1,
        -((event.clientY - rect.top) / h) * 2 + 1
      );
    }
    return new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
  }

  /**
   * Handle mouse move for dragging base point
   */
  public handleMouseMove(
    event: MouseEvent,
    camera: THREE.Camera,
    raycaster: THREE.Raycaster
  ): void {
    if (this.isDragging) {
      const mouse = this.getMouseNdc(event);
      
      raycaster.setFromCamera(mouse, camera);
      
      let intersectionPoint: THREE.Vector3 | null = null;
      
      // Base point MUST be on ENTRY_SURFACE
      if (this.entrySurfaceMeshes.length > 0) {
        const intersects = raycaster.intersectObjects(this.entrySurfaceMeshes, false);
        if (intersects.length > 0) {
          intersectionPoint = intersects[0].point;
          console.log("ENTRY via raycast", intersectionPoint);
        }
      } else {
        // Fall back to placement plane if no entry surface (shouldn't happen)
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.placementPlaneY);
        intersectionPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersectionPoint);
      }
      
      if (intersectionPoint) {
        if (this.ownership === 'AUTO') {
          this.ownership = 'MANUAL';
          this.onManualOverride?.();
        }

        this.state.basePoint.copy(intersectionPoint);

        if (this.autoAim && this.targetCenter) {
          this.updateDirectionToTarget();
        }

        this.dirty = true;
        this.updateVisuals();
        this.onTrajectoryChanged?.();
      }
    } else if (this.isRotating) {
      const deltaX = event.clientX - this.lastMouseX;
      const deltaY = event.clientY - this.lastMouseY;
      const rotationSpeed = 0.01;

      if (event.altKey) {
        const pitchAxis = new THREE.Vector3().crossVectors(this.state.direction, new THREE.Vector3(0, 1, 0)).normalize();
        if (pitchAxis.length() > 0.1) {
          const pitchAngle = -deltaY * rotationSpeed;
          this.state.direction.applyAxisAngle(pitchAxis, pitchAngle);
        }
      } else {
        const yAxis = new THREE.Vector3(0, 1, 0);
        const yawAngle = deltaX * rotationSpeed;
        this.state.direction.applyAxisAngle(yAxis, yawAngle);
      }

      this.state.direction.normalize();
      this.onManualOverride?.();
      this.dirty = true;
      this.updateVisuals();
      this.onTrajectoryChanged?.();
    } else {
      // Show ghost marker at hover position on entry surface
      const mouse = this.getMouseNdc(event);
      
      raycaster.setFromCamera(mouse, camera);
      
      let intersectionPoint: THREE.Vector3 | null = null;
      
      if (this.entrySurfaceMeshes.length > 0) {
        const intersects = raycaster.intersectObjects(this.entrySurfaceMeshes, false);
        if (intersects.length > 0) {
          intersectionPoint = intersects[0].point;
        }
      }
      
      if (intersectionPoint) {
        this.ghostMarker!.position.copy(intersectionPoint);
        this.ghostMarker!.visible = true;
      } else {
        this.ghostMarker!.visible = false;
      }
    }
    
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
  }
  
  /**
   * Handle mouse down
   * STEP 1: On ANY manual pointer interaction, set ownership to MANUAL
   * NOTE: TrajectoryTool must NOT touch OrbitControls directly
   */
  public handleMouseDown(event: MouseEvent, _altKey: boolean): void {
    if (this.ownership === 'AUTO') {
      this.ownership = 'MANUAL';
      this.onManualOverride?.();
    }

    if (event.button === 0) {
      this.isDragging = true;
      this.dirty = true;
    } else if (event.button === 2) {
      this.isRotating = true;
    }
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
  }
  
  /**
   * Handle mouse up
   * NOTE: TrajectoryTool must NOT touch OrbitControls directly
   */
  public handleMouseUp(event: MouseEvent): void {
    const wasEditing = this.isDragging || this.isRotating;
    if (event.button === 0) {
      this.isDragging = false;
    } else if (event.button === 2) {
      this.isRotating = false;
    }
    if (wasEditing) {
      this.onTrajectoryChanged?.();
    }
  }
  
  /**
   * Handle mouse wheel for adjusting corridor radius and length
   */
  public handleWheel(event: WheelEvent, shiftKey: boolean): void {
    if (this.ownership === 'AUTO') {
      this.ownership = 'MANUAL';
      this.onManualOverride?.();
    }
    if (shiftKey) {
      const delta = event.deltaY * 0.1;
      const minLength = this.recommendedMaxLength;
      const newLength = this.state.maxLength - delta;
      this.state.maxLength = Math.max(minLength, newLength);
    } else {
      const delta = event.deltaY * 0.05;
      this.state.corridorRadius = Math.max(0.5, Math.min(20.0, this.state.corridorRadius - delta));
    }
    this.dirty = true;
    this.updateVisuals();
    this.onTrajectoryChanged?.();
  }
  
  /**
   * Set corridor radius (with limits)
   */
  public setCorridorRadius(radius: number, min: number, max: number): void {
    this.state.corridorRadius = Math.max(min, Math.min(max, radius));
    this.updateVisuals();
  }
  
  /**
   * Set recommended max length (computed from entry-to-target distance)
   */
  public setRecommendedMaxLength(recommended: number): void {
    this.recommendedMaxLength = Math.max(10.0, recommended); // Minimum 10mm
    
    // If current maxLength is below recommendation, update it
    if (this.state.maxLength < this.recommendedMaxLength) {
      this.state.maxLength = this.recommendedMaxLength;
    }
    
    this.updateVisuals();
  }
  
  /**
   * Get recommended max length
   */
  public getRecommendedMaxLength(): number {
    return this.recommendedMaxLength;
  }
  
  /**
   * Reset to default position
   */
  public reset(): void {
    this.state.basePoint.set(0, this.placementPlaneY, 0);
    this.state.direction.set(1, 0, 0).normalize();
    this.dirty = false;
    this.updateVisuals();
    this.onTrajectoryChanged?.();
  }
  
  /**
   * Set visibility of tool
   */
  public setVisible(visible: boolean): void {
    this.baseMarker.visible = visible;
    this.trajectoryLine.visible = visible;
    this.centerAxisLine.visible = visible;
    this.corridorCone.visible = visible;
    if (this.ghostMarker) {
      this.ghostMarker.visible = visible && !this.isDragging;
    }
  }
  
  /**
   * Dispose resources
   */
  public dispose(): void {
    this.baseMarker.geometry.dispose();
    (this.baseMarker.material as THREE.Material).dispose();
    (this.trajectoryLine.geometry as LineGeometry).dispose();
    (this.centerAxisLine.geometry as LineGeometry).dispose();
    this.trajectoryLineMaterial.dispose();
    this.centerAxisMaterial.dispose();
    this.corridorCone.geometry.dispose();
    this.validMaterial.dispose();
    this.invalidMaterial.dispose();
    
    if (this.ghostMarker) {
      this.ghostMarker.geometry.dispose();
      (this.ghostMarker.material as THREE.Material).dispose();
    }
    
    this.scene.remove(this.baseMarker);
    this.scene.remove(this.trajectoryLine);
    this.scene.remove(this.centerAxisLine);
    this.scene.remove(this.corridorCone);
    if (this.ghostMarker) {
      this.scene.remove(this.ghostMarker);
    }
  }
}
