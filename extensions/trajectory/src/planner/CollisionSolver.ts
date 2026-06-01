/**
 * Collision validation logic for trajectory planning
 */

import * as THREE from 'three';

export type ValidationReason = 'NO_HIT' | 'BLOCKED_BY_OBSTACLE' | 'CORRIDOR_INTERSECTS_OBSTACLE' | 'BASE_NOT_ON_ENTRY_SURFACE' | 'OK';

export interface ValidationResult {
  isValid: boolean;
  reason: ValidationReason;
  hitDistance?: number;
  collisionCount?: number;
  blockedBy?: THREE.Mesh | null;
}

export interface ValidationOptions {
  targetMeshes: THREE.Mesh[];
  obstacleMeshes: THREE.Mesh[];
  entrySurfaceMeshes: THREE.Mesh[]; // Entry surface meshes
  contextMeshes: THREE.Mesh[]; // Excluded from collision tests
  basePoint: THREE.Vector3;
  direction: THREE.Vector3;
  maxLength: number;
  corridorBaseRadius: number;
  corridorTipRadius?: number;
  safetyMargin?: number; // Extra margin for obstacle clearance
  tipMargin?: number; // Allowed intersection with target near tip
  baseMargin?: number; // Allowed intersection with entry surface at base
  sampleCount?: number;
  isBaseOnEntrySurface?: boolean; // Pre-validated flag
}

// Constants
const DEFAULT_SAFETY_MARGIN = 0.5; // mm
const DEFAULT_TIP_MARGIN = 4.0; // mm
const DEFAULT_BASE_MARGIN = 1.0; // mm (allowed intersection with entry surface at base)
const DEFAULT_SAMPLE_COUNT = 40;

/**
 * Perform raycast to check line-of-sight to target
 */
function checkLineOfSight(
  base: THREE.Vector3,
  direction: THREE.Vector3,
  maxLength: number,
  targetMeshes: THREE.Mesh[],
  obstacleMeshes: THREE.Mesh[]
): { hit: THREE.Intersection | null; isTarget: boolean; distance: number; mesh: THREE.Mesh | null } {
  const raycaster = new THREE.Raycaster(base, direction, 0, maxLength);
  const allMeshes = [...targetMeshes, ...obstacleMeshes];
  
  if (allMeshes.length === 0) {
    return { hit: null, isTarget: false, distance: maxLength, mesh: null };
  }
  
  // Perform raycast against all meshes
  const intersects = raycaster.intersectObjects(allMeshes, false);
  
  if (intersects.length === 0) {
    return { hit: null, isTarget: false, distance: maxLength, mesh: null };
  }
  
  const firstHit = intersects[0];
  
  // Check if hit belongs to target
  const isTarget = targetMeshes.some(mesh => {
    let found = false;
    mesh.traverse((child) => {
      if (child === firstHit.object) {
        found = true;
      }
    });
    return found;
  });
  
  return {
    hit: firstHit,
    isTarget,
    distance: firstHit.distance,
    mesh: firstHit.object as THREE.Mesh
  };
}

/**
 * Generate sample directions for sphere collision checking
 */
function generateSampleDirections(count: number = 12): THREE.Vector3[] {
  const directions: THREE.Vector3[] = [];
  
  // Cardinal directions
  directions.push(new THREE.Vector3(1, 0, 0));
  directions.push(new THREE.Vector3(-1, 0, 0));
  directions.push(new THREE.Vector3(0, 1, 0));
  directions.push(new THREE.Vector3(0, -1, 0));
  directions.push(new THREE.Vector3(0, 0, 1));
  directions.push(new THREE.Vector3(0, 0, -1));
  
  // Diagonal directions
  const diag = 1 / Math.sqrt(3);
  directions.push(new THREE.Vector3(diag, diag, diag).normalize());
  directions.push(new THREE.Vector3(-diag, diag, diag).normalize());
  directions.push(new THREE.Vector3(diag, -diag, diag).normalize());
  directions.push(new THREE.Vector3(diag, diag, -diag).normalize());
  directions.push(new THREE.Vector3(-diag, -diag, diag).normalize());
  directions.push(new THREE.Vector3(-diag, diag, -diag).normalize());
  
  // Generate more if needed
  for (let i = directions.length; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.sin(phi) * Math.sin(theta);
    const z = Math.cos(phi);
    directions.push(new THREE.Vector3(x, y, z));
  }
  
  return directions;
}

/**
 * Check if a sphere at a point intersects with obstacles
 */
function checkSphereCollision(
  point: THREE.Vector3,
  radius: number,
  obstacleMeshes: THREE.Mesh[],
  sampleDirections: THREE.Vector3[],
  safetyMargin: number
): boolean {
  const effectiveRadius = radius + safetyMargin;
  const raycaster = new THREE.Raycaster();
  raycaster.far = effectiveRadius * 1.1;
  
  for (const dir of sampleDirections) {
    raycaster.set(point, dir);
    const intersects = raycaster.intersectObjects(obstacleMeshes, false);
    
    if (intersects.length > 0 && intersects[0].distance < effectiveRadius) {
      return true; // Collision detected
    }
  }
  
  return false;
}

/**
 * Validate trajectory placement
 */
export function validateTrajectory(options: ValidationOptions): ValidationResult {
  const {
    targetMeshes,
    obstacleMeshes,
    entrySurfaceMeshes,
    contextMeshes, // Not used in validation, just for clarity
    basePoint,
    direction,
    maxLength,
    corridorBaseRadius,
    corridorTipRadius = 0.001,
    safetyMargin = DEFAULT_SAFETY_MARGIN,
    tipMargin = DEFAULT_TIP_MARGIN,
    baseMargin = DEFAULT_BASE_MARGIN,
    sampleCount = DEFAULT_SAMPLE_COUNT,
    isBaseOnEntrySurface = false
  } = options;
  
  // Check 0: Base point must be on ENTRY_SURFACE
  if (entrySurfaceMeshes.length > 0 && !isBaseOnEntrySurface) {
    // Validate base point is on entry surface
    const raycaster = new THREE.Raycaster();
    raycaster.far = baseMargin * 2;
    
    // Check multiple directions to see if we're close to entry surface
    let onSurface = false;
    const directions = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1)
    ];
    
    for (const dir of directions) {
      raycaster.set(basePoint, dir);
      const intersects = raycaster.intersectObjects(entrySurfaceMeshes, false);
      if (intersects.length > 0 && intersects[0].distance < baseMargin) {
        onSurface = true;
        break;
      }
    }
    
    if (!onSurface) {
      return {
        isValid: false,
        reason: 'BASE_NOT_ON_ENTRY_SURFACE',
        hitDistance: undefined,
        collisionCount: 0,
        blockedBy: null
      };
    }
  }
  
  // Check 1: Line-of-sight to target
  if (targetMeshes.length === 0) {
    return {
      isValid: false,
      reason: 'NO_HIT',
      hitDistance: undefined,
      collisionCount: 0,
      blockedBy: null
    };
  }
  
  const losResult = checkLineOfSight(
    basePoint,
    direction,
    maxLength,
    targetMeshes,
    obstacleMeshes
  );
  
  if (!losResult.hit) {
    return {
      isValid: false,
      reason: 'NO_HIT',
      hitDistance: losResult.distance,
      collisionCount: 0,
      blockedBy: null
    };
  }
  
  if (!losResult.isTarget) {
    return {
      isValid: false,
      reason: 'BLOCKED_BY_OBSTACLE',
      hitDistance: losResult.distance,
      collisionCount: 0,
      blockedBy: losResult.mesh
    };
  }
  
  // Check 2: Corridor safety (cone approximated as spheres)
  const actualLength = Math.min(losResult.distance, maxLength);
  const tipPoint = new THREE.Vector3()
    .copy(basePoint)
    .add(direction.clone().multiplyScalar(actualLength));
  
  // Sample points along the trajectory
  const sampleDirections = generateSampleDirections(12);
  let collisionCount = 0;
  
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const point = new THREE.Vector3().lerpVectors(basePoint, tipPoint, t);
    
    // Distance from base point along trajectory
    const distanceFromBase = point.distanceTo(basePoint);
    const distanceFromTip = actualLength - distanceFromBase;
    
    // Compute local radius (linear taper from base to tip)
    const localRadius = corridorBaseRadius * (1 - t) + corridorTipRadius * t;
    
    // Skip collision check within base margin (allowed intersection with entry surface)
    if (distanceFromBase <= baseMargin) {
      continue;
    }
    
    // Skip collision check within tip margin (allowed intersection with target)
    if (distanceFromTip <= tipMargin) {
      continue;
    }
    
    // Check collision with obstacles
    if (checkSphereCollision(point, localRadius, obstacleMeshes, sampleDirections, safetyMargin)) {
      collisionCount++;
    }
  }
  
  if (collisionCount > 0) {
    return {
      isValid: false,
      reason: 'CORRIDOR_INTERSECTS_OBSTACLE',
      hitDistance: actualLength,
      collisionCount,
      blockedBy: null
    };
  }
  
  return {
    isValid: true,
    reason: 'OK',
    hitDistance: actualLength,
    collisionCount: 0,
    blockedBy: null
  };
}
