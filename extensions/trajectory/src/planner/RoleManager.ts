/**
 * Role Manager: Handles mesh role assignment and material management
 */

import * as THREE from 'three';
import {
  type MeshRole,
  type ObstacleSubtype,
  OBSTACLE_SUBTYPES,
  inferObstacleSubtype,
} from '@extravision/trajectory-planner';

export type { MeshRole, ObstacleSubtype };
export { OBSTACLE_SUBTYPES, inferObstacleSubtype };

export interface MeshMetadata {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  role: MeshRole;
  /** Explicit obstacle subtype, set by user via the Assign Roles modal. */
  obstacleSubtype?: ObstacleSubtype;
  originalMaterial: THREE.Material | THREE.Material[];
  originalVisible: boolean;
}

// Visual constants
const TARGET_COLOR = 0xff4444; // Bright red/orange
const TARGET_EMISSIVE = 0x330000;
const TARGET_EMISSIVE_INTENSITY = 0.8;

const OBSTACLE_COLORS = [0x00ff88, 0x0088ff, 0x88ff00]; // Green, cyan, blue
const OBSTACLE_EMISSIVE_INTENSITY = 0.2;

const ENTRY_SURFACE_COLOR = 0xd4c5b9; // Light gray/beige
const ENTRY_SURFACE_OPACITY = 0.2;
const ENTRY_SURFACE_DEPTH_WRITE = false;

const CONTEXT_COLOR = 0xffe5d4; // Flesh tone
const CONTEXT_OPACITY = 0.25;
const CONTEXT_DEPTH_WRITE = false;

export const MESH_COLOR_PRESETS = [
  { hex: 0x4488ff, name: 'Blue' },
  { hex: 0xff4444, name: 'Red' },
  { hex: 0xffe5d4, name: 'Flesh' },
  { hex: 0x44ff88, name: 'Green' },
  { hex: 0x40e0d0, name: 'Turquoise' }
] as const;

export class RoleManager {
  private meshes: Map<string, MeshMetadata> = new Map();
  private targetMesh: MeshMetadata | null = null;
  private entrySurfaceMesh: MeshMetadata | null = null;
  private roleColors: Map<string, number> = new Map();
  private meshColorOverrides: Map<string, number> = new Map();
  
  /**
   * Register a mesh with default role
   */
  public registerMesh(id: string, name: string, mesh: THREE.Mesh, defaultRole: MeshRole = 'CONTEXT'): void {
    const metadata: MeshMetadata = {
      id,
      name,
      mesh,
      role: defaultRole,
      originalMaterial: mesh.material,
      originalVisible: mesh.visible
    };
    
    this.meshes.set(id, metadata);
    this.setRole(id, defaultRole);
  }
  
  /**
   * Set role for a mesh
   */
  public setRole(meshId: string, role: MeshRole): boolean {
    const metadata = this.meshes.get(meshId);
    if (!metadata) return false;
    
    // Enforce single target constraint
    if (role === 'TARGET') {
      if (this.targetMesh && this.targetMesh.id !== meshId) {
        this.setRole(this.targetMesh.id, 'CONTEXT');
      }
      this.targetMesh = metadata;
    } else {
      if (this.targetMesh?.id === meshId) {
        this.targetMesh = null;
      }
    }
    
    // Enforce single entry surface constraint
    if (role === 'ENTRY_SURFACE') {
      if (this.entrySurfaceMesh && this.entrySurfaceMesh.id !== meshId) {
        this.setRole(this.entrySurfaceMesh.id, 'CONTEXT');
      }
      this.entrySurfaceMesh = metadata;
    } else {
      if (this.entrySurfaceMesh?.id === meshId) {
        this.entrySurfaceMesh = null;
      }
    }
    
    const oldRole = metadata.role;
    metadata.role = role;

    if (role === 'OBSTACLE' && !metadata.obstacleSubtype) {
      metadata.obstacleSubtype = inferObstacleSubtype(metadata.name);
    }
    if (role !== 'OBSTACLE') {
      metadata.obstacleSubtype = undefined;
    }

    this.applyRoleMaterials(metadata, role);
    this.applyRoleVisibility(metadata, role);
    
    return oldRole !== role;
  }
  
  /**
   * Get role of a mesh
   */
  public getRole(meshId: string): MeshRole | null {
    return this.meshes.get(meshId)?.role ?? null;
  }
  
  /**
   * Get all meshes with a specific role
   */
  public getMeshesByRole(role: MeshRole): THREE.Mesh[] {
    const result: THREE.Mesh[] = [];
    for (const metadata of this.meshes.values()) {
      if (metadata.role === role) {
        result.push(metadata.mesh);
      }
    }
    return result;
  }
  
  /**
   * Get target mesh
   */
  public getTargetMesh(): THREE.Mesh | null {
    return this.targetMesh?.mesh ?? null;
  }
  
  /**
   * Get entry surface mesh
   */
  public getEntrySurfaceMesh(): THREE.Mesh | null {
    return this.entrySurfaceMesh?.mesh ?? null;
  }
  
  /**
   * Set the obstacle subtype for a mesh. Only meaningful when role === OBSTACLE.
   */
  public setObstacleSubtype(meshId: string, subtype: ObstacleSubtype): void {
    const metadata = this.meshes.get(meshId);
    if (metadata) metadata.obstacleSubtype = subtype;
  }

  /**
   * Get obstacle subtype for a mesh.
   * Falls back to name-based inference if not explicitly set (backward compat).
   */
  public getObstacleSubtype(meshId: string): ObstacleSubtype | undefined {
    const metadata = this.meshes.get(meshId);
    if (!metadata || metadata.role !== 'OBSTACLE') return undefined;
    if (metadata.obstacleSubtype) return metadata.obstacleSubtype;
    return inferObstacleSubtype(metadata.name);
  }

  /**
   * Get obstacle meshes grouped by explicit subtype.
   * Source of truth for planner / voxelizer input.
   */
  public getObstaclesBySubtype(): Record<ObstacleSubtype, THREE.Mesh[]> {
    const groups: Record<ObstacleSubtype, THREE.Mesh[]> = {
      vessel: [], ventricle: [], sinus: [], other: [],
    };
    for (const meta of this.meshes.values()) {
      if (meta.role !== 'OBSTACLE') continue;
      const sub = meta.obstacleSubtype ?? inferObstacleSubtype(meta.name);
      groups[sub].push(meta.mesh);
    }
    return groups;
  }

  /**
   * Get all registered meshes metadata
   */
  public getAllMeshes(): MeshMetadata[] {
    return Array.from(this.meshes.values());
  }
  
  /**
   * Get mesh metadata by ID
   */
  public getMeshMetadata(meshId: string): MeshMetadata | null {
    return this.meshes.get(meshId) ?? null;
  }
  
  /**
   * Apply role-specific materials
   */
  private applyRoleMaterials(metadata: MeshMetadata, role: MeshRole): void {
    const { mesh } = metadata;
    
    // Dispose old material if we created it
    if (mesh.material && (mesh.material as any).__roleMaterial) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    
    let material: THREE.Material;
    
    switch (role) {
      case 'ENTRY_SURFACE':
        material = new THREE.MeshStandardMaterial({
          color: this.meshColorOverrides.get(metadata.id) ?? ENTRY_SURFACE_COLOR,
          transparent: true,
          opacity: ENTRY_SURFACE_OPACITY,
          depthWrite: ENTRY_SURFACE_DEPTH_WRITE,
          side: THREE.DoubleSide
        });
        mesh.renderOrder = 75; // Between target and obstacles
        break;
        
      case 'TARGET':
        material = new THREE.MeshStandardMaterial({
          color: this.meshColorOverrides.get(metadata.id) ?? TARGET_COLOR,
          emissive: TARGET_EMISSIVE,
          emissiveIntensity: TARGET_EMISSIVE_INTENSITY,
          metalness: 0.1,
          roughness: 0.3,
          transparent: true,
          opacity: 0.45
        });
        mesh.renderOrder = 100; // Between cone (80) and trajectory line (200)
        break;
        
      case 'OBSTACLE':
        const obstacleColor = this.meshColorOverrides.get(metadata.id)
          ?? OBSTACLE_COLORS[Array.from(this.meshes.values()).filter(m => m.role === 'OBSTACLE').length % OBSTACLE_COLORS.length];
        
        material = new THREE.MeshStandardMaterial({
          color: obstacleColor,
          emissive: obstacleColor,
          emissiveIntensity: OBSTACLE_EMISSIVE_INTENSITY,
          metalness: 0.2,
          roughness: 0.4
        });
        mesh.renderOrder = 50;
        this.roleColors.set(metadata.id, obstacleColor);
        break;
        
      case 'CONTEXT':
        material = new THREE.MeshStandardMaterial({
          color: this.meshColorOverrides.get(metadata.id) ?? CONTEXT_COLOR,
          transparent: true,
          opacity: CONTEXT_OPACITY,
          depthWrite: CONTEXT_DEPTH_WRITE,
          side: THREE.DoubleSide
        });
        mesh.renderOrder = 0;
        break;
        
      case 'IGNORE':
        // Use original material but will be hidden
        material = metadata.originalMaterial instanceof THREE.Material 
          ? metadata.originalMaterial 
          : metadata.originalMaterial[0];
        break;
        
      default:
        material = mesh.material instanceof THREE.Material 
          ? mesh.material 
          : mesh.material[0];
    }
    
    (material as any).__roleMaterial = true;
    mesh.material = material;
  }
  
  /**
   * Apply role-specific visibility
   */
  private applyRoleVisibility(metadata: MeshMetadata, role: MeshRole): void {
    const { mesh } = metadata;
    
    if (role === 'IGNORE') {
      mesh.visible = false;
    } else {
      mesh.visible = metadata.originalVisible;
    }
  }
  
  /**
   * Pulse obstacle mesh to indicate collision
   */
  public pulseObstacle(mesh: THREE.Mesh, duration: number = 500): void {
    const metadata = Array.from(this.meshes.values()).find(m => m.mesh === mesh);
    if (!metadata || metadata.role !== 'OBSTACLE') return;
    
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!material || !material.emissive) return;
    
    const originalIntensity = material.emissiveIntensity;
    const pulseIntensity = 1.0;
    
    const startTime = performance.now();
    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed < duration) {
        const t = elapsed / duration;
        const factor = 0.5 + 0.5 * Math.sin(t * Math.PI * 4); // Pulsing
        material.emissiveIntensity = originalIntensity + (pulseIntensity - originalIntensity) * factor;
        requestAnimationFrame(animate);
      } else {
        material.emissiveIntensity = originalIntensity;
      }
    };
    
    animate();
  }
  
  /**
   * Get color for a role (for UI swatches)
   */
  public getRoleColor(meshId: string): number {
    const override = this.meshColorOverrides.get(meshId);
    if (override !== undefined) return override;
    
    const metadata = this.meshes.get(meshId);
    if (!metadata) return 0x888888;
    
    switch (metadata.role) {
      case 'TARGET':
        return TARGET_COLOR;
      case 'OBSTACLE':
        return this.roleColors.get(meshId) ?? OBSTACLE_COLORS[0];
      case 'ENTRY_SURFACE':
        return ENTRY_SURFACE_COLOR;
      case 'CONTEXT':
        return CONTEXT_COLOR;
      case 'IGNORE':
        return 0x444444;
      default:
        return 0x888888;
    }
  }
  
  /**
   * Set color for a specific mesh
   */
  public setMeshColor(meshId: string, color: number): void {
    this.meshColorOverrides.set(meshId, color);
    const metadata = this.meshes.get(meshId);
    if (metadata) {
      this.applyRoleMaterials(metadata, metadata.role);
    }
  }

  /**
   * Get color for a mesh (override or role default)
   */
  public getMeshColor(meshId: string): number {
    return this.meshColorOverrides.get(meshId) ?? this.getRoleColor(meshId);
  }

  /**
   * Reset all roles to default
   */
  public reset(): void {
    for (const metadata of this.meshes.values()) {
      metadata.mesh.material = metadata.originalMaterial;
      metadata.mesh.visible = metadata.originalVisible;
      metadata.mesh.renderOrder = 0;
    }
    this.meshes.clear();
    this.targetMesh = null;
    this.entrySurfaceMesh = null;
    this.roleColors.clear();
    this.meshColorOverrides.clear();
  }
}
