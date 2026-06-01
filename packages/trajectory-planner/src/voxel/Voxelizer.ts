/**
 * Voxelizer — converts Three.js meshes to binary voxel grids.
 *
 * Strategy: for each voxel centre, cast a ray in +X and count mesh
 * intersections.  Odd count → inside (Jordan curve theorem for
 * watertight meshes).  Falls back to surface-distance heuristic for
 * non-watertight geometry.
 *
 * Requires BVH to be pre-built on every geometry (done by Loader.ts).
 */

import * as THREE from 'three';
import type { VoxelGrid, VoxelMasks, MaskStats, VoxelizeResult } from '../types';
import type { MeshRole } from '../roles';

// ─── helpers ────────────────────────────────────────────────────────

function vec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

/**
 * Compute an axis-aligned bounding box that encloses every supplied
 * mesh, expanded by `pad` mm on each side.
 */
function computeUnionBBox(meshes: THREE.Mesh[], pad: number): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  box.min.subScalar(pad);
  box.max.addScalar(pad);
  return box;
}

// ─── core voxelisation ──────────────────────────────────────────────

/**
 * Create an empty VoxelGrid that covers `bbox` at the given spacing.
 */
export function createEmptyGrid(bbox: THREE.Box3, spacing: number): VoxelGrid {
  const size = bbox.getSize(vec3(0, 0, 0));
  const nx = Math.ceil(size.x / spacing) + 1;
  const ny = Math.ceil(size.y / spacing) + 1;
  const nz = Math.ceil(size.z / spacing) + 1;
  return {
    data: new Uint8Array(nx * ny * nz),
    dims: [nx, ny, nz],
    spacing,
    origin: bbox.min.clone(),
  };
}

/** Convert (ix,iy,iz) → flat index. */
export function gridIndex(grid: VoxelGrid, ix: number, iy: number, iz: number): number {
  const [nx, ny] = grid.dims;
  return ix + iy * nx + iz * nx * ny;
}

/** Convert flat index → world-space position of that voxel centre. */
export function gridToWorld(grid: VoxelGrid, ix: number, iy: number, iz: number): THREE.Vector3 {
  return vec3(
    grid.origin.x + ix * grid.spacing,
    grid.origin.y + iy * grid.spacing,
    grid.origin.z + iz * grid.spacing,
  );
}

/** Convert world position → nearest grid indices (clamped). */
export function worldToGrid(grid: VoxelGrid, p: THREE.Vector3): [number, number, number] {
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
 * Fill `grid` with 1 for every voxel whose centre lies inside any of
 * the given meshes (ray-parity test along +X).
 */
function voxelizeMeshes(grid: VoxelGrid, meshes: THREE.Mesh[]): void {
  if (meshes.length === 0) return;

  const [nx, ny, nz] = grid.dims;
  const raycaster = new THREE.Raycaster();
  const dir = vec3(1, 0, 0);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      const origin = gridToWorld(grid, 0, iy, iz);
      origin.x = grid.origin.x - grid.spacing; // start just outside bbox

      raycaster.set(origin, dir);
      raycaster.far = (nx + 2) * grid.spacing;

      const intersections = raycaster.intersectObjects(meshes, false);

      // Walk the sorted hit list and toggle inside/outside for each x-column
      if (intersections.length === 0) continue;

      // Pre-sort by distance (Raycaster usually returns sorted, but be safe)
      intersections.sort((a, b) => a.distance - b.distance);

      // For each ix, determine parity at that x position
      for (let ix = 0; ix < nx; ix++) {
        const xWorld = grid.origin.x + ix * grid.spacing;
        const distFromOrigin = xWorld - origin.x;

        // Count how many intersection surfaces are before this x
        let crossings = 0;
        for (const hit of intersections) {
          if (hit.distance < distFromOrigin) crossings++;
          else break;
        }

        if (crossings % 2 === 1) {
          grid.data[gridIndex(grid, ix, iy, iz)] = 1;
        }
      }
    }
  }
}

/**
 * Surface-only voxelisation fallback: mark voxels within `thickness`
 * of the mesh surface. Useful for non-watertight vessel meshes.
 */
function voxelizeSurface(grid: VoxelGrid, meshes: THREE.Mesh[], thickness: number): void {
  if (meshes.length === 0) return;

  const [nx, ny, nz] = grid.dims;
  const thickSq = thickness * thickness;
  const tmpTarget = new THREE.Vector3();

  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry & { boundsTree?: any };
    if (!geo.boundsTree) continue;

    const invMatrix = new THREE.Matrix4().copy(mesh.matrixWorld).invert();

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          if (grid.data[gridIndex(grid, ix, iy, iz)] === 1) continue;

          const world = gridToWorld(grid, ix, iy, iz);
          const local = world.clone().applyMatrix4(invMatrix);

          const closest = geo.boundsTree.closestPointToPoint(local, tmpTarget);
          if (!closest) continue;
          if (local.distanceToSquared(tmpTarget) <= thickSq) {
            grid.data[gridIndex(grid, ix, iy, iz)] = 1;
          }
        }
      }
    }
  }
}

// ─── binary dilation ────────────────────────────────────────────────

/**
 * Dilate a binary mask in-place by `radiusMm` using a spherical
 * structuring element.  Every voxel within `radiusMm` of any set
 * voxel is set to 1.
 *
 * Implementation: single-pass output via pre-computed offsets.
 * Adequate for typical brain grids at 1 mm (radius ≤ ~5 voxels).
 */
export function dilateMask(mask: VoxelGrid, radiusMm: number): VoxelGrid {
  if (radiusMm <= 0) return mask;

  const [nx, ny, nz] = mask.dims;
  const sp = mask.spacing;
  const rVox = Math.ceil(radiusMm / sp);
  const rSq = (radiusMm / sp) * (radiusMm / sp);

  // Pre-compute spherical offset list
  const offsets: [number, number, number][] = [];
  for (let dz = -rVox; dz <= rVox; dz++) {
    for (let dy = -rVox; dy <= rVox; dy++) {
      for (let dx = -rVox; dx <= rVox; dx++) {
        if (dx * dx + dy * dy + dz * dz <= rSq) {
          offsets.push([dx, dy, dz]);
        }
      }
    }
  }

  const n = nx * ny * nz;
  const out = new Uint8Array(n);

  // Collect seeds (set voxels) to avoid reading from the output
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (mask.data[gridIndex(mask, ix, iy, iz)] !== 1) continue;
        for (const [dx, dy, dz] of offsets) {
          const nx2 = ix + dx, ny2 = iy + dy, nz2 = iz + dz;
          if (nx2 >= 0 && nx2 < nx && ny2 >= 0 && ny2 < ny && nz2 >= 0 && nz2 < nz) {
            out[gridIndex(mask, nx2, ny2, nz2)] = 1;
          }
        }
      }
    }
  }

  return {
    data: out,
    dims: mask.dims,
    spacing: mask.spacing,
    origin: mask.origin.clone(),
  };
}

// ─── mask statistics ────────────────────────────────────────────────

/** Compute debug statistics for a binary mask. */
export function computeMaskStats(mask: VoxelGrid): MaskStats {
  const [nx, ny, nz] = mask.dims;
  let count = 0;
  let minX = nx, minY = ny, minZ = nz;
  let maxX = -1, maxY = -1, maxZ = -1;

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (mask.data[gridIndex(mask, ix, iy, iz)] === 1) {
          count++;
          if (ix < minX) minX = ix;
          if (iy < minY) minY = iy;
          if (iz < minZ) minZ = iz;
          if (ix > maxX) maxX = ix;
          if (iy > maxY) maxY = iy;
          if (iz > maxZ) maxZ = iz;
        }
      }
    }
  }

  const totalVoxels = nx * ny * nz;
  const sp3 = mask.spacing * mask.spacing * mask.spacing;

  if (count === 0) {
    return {
      voxelCount: 0,
      bboxMin: [0, 0, 0],
      bboxMax: [0, 0, 0],
      bboxCoverage: 0,
      estimatedVolumeMm3: 0,
    };
  }

  return {
    voxelCount: count,
    bboxMin: [minX, minY, minZ],
    bboxMax: [maxX, maxY, maxZ],
    bboxCoverage: count / totalVoxels,
    estimatedVolumeMm3: count * sp3,
  };
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Explicit obstacle subtype groups, as assigned by the user in the
 * Assign Roles modal. The Voxelizer consumes these directly — it does
 * NOT inspect mesh.name to determine obstacle subtypes.
 */
export interface ObstacleGroups {
  vessel: THREE.Mesh[];
  ventricle: THREE.Mesh[];
  sinus: THREE.Mesh[];
  other: THREE.Mesh[];
}

export interface VoxelizerInput {
  /** Map from role → meshes */
  meshesByRole: Map<MeshRole, THREE.Mesh[]>;
  /** Isotropic voxel spacing in mm (default 1) */
  spacing?: number;
  /**
   * Surface thickness in mm for non-watertight structures
   * (vessels, sinuses). Default 1.5.
   */
  surfaceThickness?: number;
  /**
   * Optional binary dilation radius (mm) applied to vessel,
   * ventricle, and sinus masks after voxelisation.
   * Expands obstacle regions to approximate a safety corridor.
   * Set to 0 or omit to disable.  Default 0.
   */
  dilationRadiusMm?: number;
  /**
   * Explicit obstacle subtype grouping from the user's role assignment.
   * When provided, the Voxelizer uses these groups directly.
   * When omitted (backward compat), falls back to grouping all OBSTACLE
   * meshes as "other" (conservative fallback — no subtype-specific masks).
   */
  obstacleGroups?: ObstacleGroups;
}

/**
 * Voxelize the scene meshes into per-role binary masks that share a
 * common grid (same origin, dims, spacing).
 *
 * Returns both the masks and per-mask debug statistics.
 */
export function voxelizeScene(input: VoxelizerInput): VoxelizeResult {
  const {
    meshesByRole,
    spacing = 1.0,
    surfaceThickness = 1.5,
    dilationRadiusMm = 0,
  } = input;

  // Union bbox over ALL meshes (every role) with 2-voxel pad
  const allMeshes: THREE.Mesh[] = [];
  for (const list of meshesByRole.values()) allMeshes.push(...list);

  const bbox = computeUnionBBox(allMeshes, spacing * 2);

  // --- hematoma (TARGET) — solid fill via ray parity ---
  const hematomaMask = createEmptyGrid(bbox, spacing);
  voxelizeMeshes(hematomaMask, meshesByRole.get('TARGET') ?? []);

  // --- obstacles — use explicit subtype groups from user assignment ---
  const allObstacles = meshesByRole.get('OBSTACLE') ?? [];
  let vesselMeshes: THREE.Mesh[];
  let ventricleMeshes: THREE.Mesh[];
  let sinusMeshes: THREE.Mesh[];
  let otherObstacles: THREE.Mesh[];

  if (input.obstacleGroups) {
    vesselMeshes = input.obstacleGroups.vessel;
    ventricleMeshes = input.obstacleGroups.ventricle;
    sinusMeshes = input.obstacleGroups.sinus;
    otherObstacles = input.obstacleGroups.other;
    console.debug(
      `[Voxelizer] Obstacle subtypes: vessel=${vesselMeshes.length}` +
      ` ventricle=${ventricleMeshes.length} sinus=${sinusMeshes.length}` +
      ` other=${otherObstacles.length}`
    );
  } else {
    vesselMeshes = [];
    ventricleMeshes = [];
    sinusMeshes = [];
    otherObstacles = allObstacles;
    if (allObstacles.length > 0) {
      console.warn('[Voxelizer] No explicit obstacle subtype groups provided; all obstacles treated as "other"');
    }
  }

  // Vessels / sinuses: surface-based voxelisation (often not watertight)
  let vesselMask = vesselMeshes.length > 0 ? createEmptyGrid(bbox, spacing) : null;
  if (vesselMask) voxelizeSurface(vesselMask, vesselMeshes, surfaceThickness);

  // Also mark "other" obstacles into vesselMask as a conservative fallback
  if (otherObstacles.length > 0) {
    const fallback = vesselMask ?? createEmptyGrid(bbox, spacing);
    voxelizeSurface(fallback, otherObstacles, surfaceThickness);
    if (!vesselMask && fallback.data.some(v => v === 1)) {
      vesselMask = fallback;
    }
  }

  let ventricleMask = ventricleMeshes.length > 0 ? createEmptyGrid(bbox, spacing) : null;
  if (ventricleMask) voxelizeMeshes(ventricleMask, ventricleMeshes);

  let sinusMask = sinusMeshes.length > 0 ? createEmptyGrid(bbox, spacing) : null;
  if (sinusMask) voxelizeSurface(sinusMask, sinusMeshes, surfaceThickness);

  // Optional dilation of obstacle masks
  if (dilationRadiusMm > 0) {
    if (vesselMask) vesselMask = dilateMask(vesselMask, dilationRadiusMm);
    if (ventricleMask) ventricleMask = dilateMask(ventricleMask, dilationRadiusMm);
    if (sinusMask) sinusMask = dilateMask(sinusMask, dilationRadiusMm);
  }

  // Brain mask (ENTRY_SURFACE used as skull proxy — optional)
  const entryMeshes = meshesByRole.get('ENTRY_SURFACE') ?? [];
  const brainMask = entryMeshes.length > 0 ? createEmptyGrid(bbox, spacing) : null;
  if (brainMask) voxelizeMeshes(brainMask, entryMeshes);

  const masks: VoxelMasks = { hematomaMask, vesselMask, ventricleMask, sinusMask, brainMask };

  const stats = {
    hematoma: computeMaskStats(hematomaMask),
    vessel: vesselMask ? computeMaskStats(vesselMask) : null,
    ventricle: ventricleMask ? computeMaskStats(ventricleMask) : null,
    sinus: sinusMask ? computeMaskStats(sinusMask) : null,
    brain: brainMask ? computeMaskStats(brainMask) : null,
  };

  return { masks, stats };
}

// ─── distance field ─────────────────────────────────────────────────
//
// The evaluator and metrics modules consume `DistanceField`
// (= Float32Array) without knowing how it was produced.
//
// To upgrade to an exact EDT (e.g. Felzenszwalb-Huttenlocher) or a
// mesh-based SDF, implement a function with the same signature:
//
//   (mask: VoxelGrid) => DistanceField
//
// and pass it via the optimizer config — no evaluator changes needed.
// ─────────────────────────────────────────────────────────────────────

/**
 * **Approximate** unsigned distance field from a binary mask.
 *
 * Uses a 26-connected BFS starting from every set voxel.  The result
 * is *not* an exact Euclidean Distance Transform — distances along
 * diagonal steps over-estimate by up to √3/√2 ≈ 1.22× compared to
 * the true EDT.  This is acceptable for proximity-penalty scoring but
 * should be replaced by an exact EDT for sub-voxel accuracy (e.g.
 * Saito-Toriwaki or Felzenszwalb-Huttenlocher).
 *
 * Adequate for typical brain volumes at 1 mm resolution (≤ 256³).
 *
 * Returns Float32Array with distance in mm at each voxel.
 */
export function computeDistanceField(mask: VoxelGrid): Float32Array {
  const [nx, ny, nz] = mask.dims;
  const n = nx * ny * nz;
  const nxy = nx * ny;
  const dist = new Float32Array(n);
  dist.fill(Infinity);

  // Pre-compute 26-connected neighbour offsets and their step distances
  const offsets: number[] = [];
  const steps: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        offsets.push(dx + dy * nx + dz * nxy);
        steps.push(Math.sqrt(dx * dx + dy * dy + dz * dz) * mask.spacing);
      }
    }
  }

  // Use flat Uint32Array queue (indices) instead of tuple arrays to avoid GC pressure
  let queue = new Uint32Array(Math.min(n, 1 << 20));
  let qLen = 0;
  const visited = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (mask.data[i] === 1) {
      dist[i] = 0;
      visited[i] = 1;
      if (qLen >= queue.length) {
        const next = new Uint32Array(queue.length * 2);
        next.set(queue);
        queue = next;
      }
      queue[qLen++] = i;
    }
  }
  if (qLen === 0) return dist;

  let head = 0;
  while (head < qLen) {
    const ci = queue[head++];
    const cDist = dist[ci];
    const cz = (ci / nxy) | 0;
    const cy = ((ci - cz * nxy) / nx) | 0;
    const cx = ci - cz * nxy - cy * nx;

    for (let k = 0; k < offsets.length; k++) {
      const ni = ci + offsets[k];
      // Boundary check via coordinate reconstruction
      const nzz = (ni / nxy) | 0;
      const nyy = ((ni - nzz * nxy) / nx) | 0;
      const nxx = ni - nzz * nxy - nyy * nx;
      if (nxx < 0 || nxx >= nx || nyy < 0 || nyy >= ny || nzz < 0 || nzz >= nz) continue;
      // Verify adjacency (prevent wrap-around)
      if (Math.abs(nxx - cx) > 1 || Math.abs(nyy - cy) > 1 || Math.abs(nzz - cz) > 1) continue;

      const nd = cDist + steps[k];
      if (nd < dist[ni]) {
        dist[ni] = nd;
        if (!visited[ni]) {
          visited[ni] = 1;
          if (qLen >= queue.length) {
            const next = new Uint32Array(queue.length * 2);
            next.set(queue);
            queue = next;
          }
          queue[qLen++] = ni;
        }
      }
    }
  }

  return dist;
}
