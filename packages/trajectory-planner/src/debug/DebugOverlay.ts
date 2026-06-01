/**
 * DebugOverlay — optional Three.js scene objects for visualising
 * planner internals.
 *
 * All geometry is added to a single THREE.Group so it can be toggled
 * or removed in one call.  Nothing here touches the planner logic.
 *
 * Visualisations:
 *   - PCA axis line (cyan)
 *   - Top candidate trajectories (thin grey lines)
 *   - Selected trajectory (thick green line)
 *   - firstHematomaHit marker (yellow sphere)
 *   - Dilated obstacle mask point-cloud (optional, magenta)
 */

import * as THREE from 'three';
import type { ScoredTrajectory, VoxelGrid } from '../types';
import type { OptimizationResult } from '../planner/TrajectoryOptimizer';
import { gridIndex, gridToWorld } from '../voxel/Voxelizer';

// ─── constants ──────────────────────────────────────────────────────

const PCA_COLOR = 0x00ffff;
const PCA_LENGTH_SCALE = 1.5;
const CANDIDATE_COLOR = 0x888888;
const CANDIDATE_OPACITY = 0.35;
const SELECTED_COLOR = 0x00ff66;
const HIT_MARKER_COLOR = 0xffff00;
const HIT_MARKER_RADIUS = 1.5;
const DILATED_COLOR = 0xff00ff;
const DILATED_POINT_SIZE = 2.0;

// ─── helpers ────────────────────────────────────────────────────────

function makeLine(
  from: THREE.Vector3,
  to: THREE.Vector3,
  color: number,
  opacity: number,
  linewidth = 1,
): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: true,
    linewidth,
  });
  return new THREE.Line(geo, mat);
}

function makeSphere(
  pos: THREE.Vector3,
  radius: number,
  color: number,
): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  return mesh;
}

function collectMaskPositions(mask: VoxelGrid, maxPoints: number): Float32Array {
  const [nx, ny, nz] = mask.dims;
  const positions: number[] = [];
  // Subsample to keep point count manageable
  const stride = Math.max(1, Math.floor(Math.cbrt(
    (nx * ny * nz) / maxPoints,
  )));

  for (let iz = 0; iz < nz; iz += stride) {
    for (let iy = 0; iy < ny; iy += stride) {
      for (let ix = 0; ix < nx; ix += stride) {
        if (mask.data[gridIndex(mask, ix, iy, iz)] === 1) {
          const w = gridToWorld(mask, ix, iy, iz);
          positions.push(w.x, w.y, w.z);
        }
        if (positions.length / 3 >= maxPoints) break;
      }
      if (positions.length / 3 >= maxPoints) break;
    }
    if (positions.length / 3 >= maxPoints) break;
  }

  return new Float32Array(positions);
}

// ─── public API ─────────────────────────────────────────────────────

export interface OverlayOptions {
  showPCAAxis?: boolean;
  showTopCandidates?: boolean;
  showSelected?: boolean;
  showHematomaHitMarker?: boolean;
  showDilatedMask?: boolean;
  /** Max points rendered for the dilated mask point-cloud.  Default 50 000. */
  dilatedMaxPoints?: number;
  /** Maximum number of top candidates to draw.  Default 10. */
  maxCandidateLines?: number;
}

const DEFAULT_OPTIONS: Required<OverlayOptions> = {
  showPCAAxis: true,
  showTopCandidates: false,
  showSelected: true,
  showHematomaHitMarker: true,
  showDilatedMask: false,
  dilatedMaxPoints: 15_000,
  maxCandidateLines: 5,
};

/**
 * Build a THREE.Group containing debug visualisation objects.
 *
 * Add the returned group to the scene to show overlays; remove it
 * to hide them.  Call `disposeOverlay` to free GPU resources.
 */
export function buildOverlay(
  result: OptimizationResult,
  opts?: OverlayOptions,
  dilatedMask?: VoxelGrid | null,
): THREE.Group {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const group = new THREE.Group();
  group.name = '__plannerDebugOverlay';

  const { pca, trajectories } = result;

  // ── PCA axis ─────────────────────────────────────────────────────
  if (o.showPCAAxis) {
    const halfLen = PCA_LENGTH_SCALE *
      Math.sqrt(pca.eigenValues[0]) * pca.anisotropy.elongation;
    const from = pca.center.clone().addScaledVector(pca.principalAxis, -halfLen);
    const to = pca.center.clone().addScaledVector(pca.principalAxis, halfLen);
    group.add(makeLine(from, to, PCA_COLOR, 1));
    group.add(makeSphere(pca.center, 1.0, PCA_COLOR));
  }

  // ── Top candidate trajectories ───────────────────────────────────
  if (o.showTopCandidates && trajectories.length > 1) {
    const n = Math.min(trajectories.length, o.maxCandidateLines);
    for (let i = 1; i < n; i++) {
      const t = trajectories[i];
      const tip = t.entry.clone().addScaledVector(t.direction, t.length);
      group.add(makeLine(t.entry, tip, CANDIDATE_COLOR, CANDIDATE_OPACITY));
    }
  }

  // ── Selected trajectory ──────────────────────────────────────────
  if (o.showSelected && trajectories.length > 0) {
    const sel = trajectories[0];
    const tip = sel.entry.clone().addScaledVector(sel.direction, sel.length);
    group.add(makeLine(sel.entry, tip, SELECTED_COLOR, 1, 2));
    group.add(makeSphere(sel.entry, 1.0, SELECTED_COLOR));
  }

  // ── First hematoma hit marker ────────────────────────────────────
  if (o.showHematomaHitMarker && trajectories.length > 0) {
    const hit = trajectories[0].hitPoints.firstHematomaHit;
    if (hit) {
      group.add(makeSphere(hit, HIT_MARKER_RADIUS, HIT_MARKER_COLOR));
    }
  }

  // ── Dilated mask point-cloud ─────────────────────────────────────
  if (o.showDilatedMask && dilatedMask) {
    const positions = collectMaskPositions(dilatedMask, o.dilatedMaxPoints);
    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: DILATED_COLOR,
        size: DILATED_POINT_SIZE,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      });
      group.add(new THREE.Points(geo, mat));
    }
  }

  return group;
}

/**
 * Dispose all GPU resources held by a previously-built overlay group.
 */
export function disposeOverlay(group: THREE.Group): void {
  group.traverse(obj => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
      obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) {
        mat.forEach(m => m.dispose());
      } else {
        mat.dispose();
      }
    }
  });
  group.removeFromParent();
}
