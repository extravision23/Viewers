/**
 * PCAAnalyzer — Principal Component Analysis on voxel point clouds.
 *
 * Computes the covariance matrix of occupied voxels and extracts
 * eigen-vectors via the analytical cubic formula (3×3 symmetric).
 * No external linear-algebra dependency required.
 */

import * as THREE from 'three';
import type { VoxelGrid, PCAResult, PCAAnisotropy } from '../types';
import { gridIndex, gridToWorld } from '../voxel/Voxelizer';

// ─── helpers ────────────────────────────────────────────────────────

/** Collect world-space centres of all set voxels in `mask`. */
export function collectOccupiedVoxels(mask: VoxelGrid): THREE.Vector3[] {
  const [nx, ny, nz] = mask.dims;
  const points: THREE.Vector3[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (mask.data[gridIndex(mask, ix, iy, iz)] === 1) {
          points.push(gridToWorld(mask, ix, iy, iz));
        }
      }
    }
  }
  return points;
}

/** Compute centroid of a point cloud. */
function centroid(pts: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.divideScalar(pts.length);
  return c;
}

/**
 * 3×3 symmetric covariance matrix [c00, c01, c02, c11, c12, c22].
 * Stored in upper-triangular packed form.
 */
type Sym3 = [number, number, number, number, number, number];

function covariance(pts: THREE.Vector3[], mean: THREE.Vector3): Sym3 {
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (const p of pts) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    const dz = p.z - mean.z;
    c00 += dx * dx;
    c01 += dx * dy;
    c02 += dx * dz;
    c11 += dy * dy;
    c12 += dy * dz;
    c22 += dz * dz;
  }
  const n = pts.length;
  return [c00 / n, c01 / n, c02 / n, c11 / n, c12 / n, c22 / n];
}

// ─── 3×3 symmetric eigenvalue solver (Cardano) ─────────────────────

/**
 * Eigenvalues of a 3×3 real symmetric matrix using the closed-form
 * Cardano / trigonometric method.  Returns them in descending order.
 *
 * Reference: "Efficient numerical diagonalization of Hermitian 3×3
 * matrices" — Kopp, 2006.
 */
function eigenvaluesSym3(s: Sym3): [number, number, number] {
  const [a, b, c, d, e, f] = s;
  // Matrix:
  // | a  b  c |
  // | b  d  e |
  // | c  e  f |

  const trace = a + d + f;
  const q = trace / 3;

  // p² = 1/6 * ((a-q)²+(d-q)²+(f-q)² + 2(b²+c²+e²))
  const p2 = (
    (a - q) * (a - q) + (d - q) * (d - q) + (f - q) * (f - q)
    + 2 * (b * b + c * c + e * e)
  ) / 6;
  const p = Math.sqrt(p2);

  if (p < 1e-14) {
    return [q, q, q];
  }

  const invP = 1 / p;

  // B = (1/p) * (A - qI)
  const b00 = (a - q) * invP;
  const b01 = b * invP;
  const b02 = c * invP;
  const b11 = (d - q) * invP;
  const b12 = e * invP;
  const b22 = (f - q) * invP;

  // det(B) / 2
  const detB_half = (
    b00 * (b11 * b22 - b12 * b12)
    - b01 * (b01 * b22 - b12 * b02)
    + b02 * (b01 * b12 - b11 * b02)
  ) / 2;

  const r = Math.max(-1, Math.min(1, detB_half));
  const phi = Math.acos(r) / 3;

  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
  const e2 = 3 * q - e1 - e3; // trace = e1+e2+e3

  const arr = [e1, e2, e3].sort((x, y) => y - x) as [number, number, number];
  return arr;
}

/**
 * Eigenvector for a given eigenvalue λ of the symmetric 3×3 matrix.
 * Finds the null-space vector of (A - λI) via cross-product of two rows.
 */
function eigenvectorSym3(s: Sym3, lambda: number): THREE.Vector3 {
  const [a, b, c, d, e, f] = s;
  // Rows of (A - λI)
  const r0 = new THREE.Vector3(a - lambda, b, c);
  const r1 = new THREE.Vector3(b, d - lambda, e);
  const r2 = new THREE.Vector3(c, e, f - lambda);

  // Take cross product of two rows — the one with largest magnitude wins
  const c01 = new THREE.Vector3().crossVectors(r0, r1);
  const c02 = new THREE.Vector3().crossVectors(r0, r2);
  const c12 = new THREE.Vector3().crossVectors(r1, r2);

  const l01 = c01.lengthSq();
  const l02 = c02.lengthSq();
  const l12 = c12.lengthSq();

  if (l01 >= l02 && l01 >= l12) return c01.normalize();
  if (l02 >= l12) return c02.normalize();
  return c12.normalize();
}

// ─── anisotropy ─────────────────────────────────────────────────────

/**
 * Minimum elongation ratio (λ1/λ2) required for the principal axis
 * to be considered "stable" — i.e. clearly separated from the second
 * component.  Below this threshold the hematoma is roughly spherical
 * and cone direction is essentially arbitrary.
 */
const STABILITY_THRESHOLD = 1.5;
/**
 * Once elongation reaches this level, the axis-alignment penalty is
 * applied at full strength. Between STABILITY_THRESHOLD and this
 * value the penalty ramps up smoothly.
 */
export const FULL_AXIS_PENALTY_ELONGATION = 2.5;

function computeAnisotropy(ev: [number, number, number]): PCAAnisotropy {
  const [l1, l2, l3] = ev;
  const safeL2 = Math.max(l2, 1e-12);
  const safeL3 = Math.max(l3, 1e-12);

  const elongation = l1 / safeL2;
  const flatness = l2 / safeL3;
  const spread = l1 / safeL3;
  const isStable = elongation >= STABILITY_THRESHOLD;

  return { elongation, flatness, spread, isStable };
}

/**
 * Convert PCA anisotropy into a [0,1] multiplier for the axis
 * alignment penalty:
 * - roughly spherical / unstable target => 0
 * - clearly elongated target => 1
 * - in-between => linear ramp
 */
export function computeAxisPenaltyScale(
  anisotropy: PCAAnisotropy | null | undefined
): number {
  if (!anisotropy?.isStable) {
    return 0;
  }

  const ramp =
    (anisotropy.elongation - STABILITY_THRESHOLD) /
    (FULL_AXIS_PENALTY_ELONGATION - STABILITY_THRESHOLD);

  return Math.max(0, Math.min(1, ramp));
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Run PCA on all occupied voxels in a binary mask.
 *
 * Returns the centroid, the first principal axis (largest variance
 * direction, normalized), the three eigenvalues in descending order,
 * and anisotropy/stability metrics.
 */
export function analyzePCA(mask: VoxelGrid): PCAResult {
  const pts = collectOccupiedVoxels(mask);
  if (pts.length === 0) {
    return {
      center: new THREE.Vector3(),
      principalAxis: new THREE.Vector3(0, 0, 1),
      eigenValues: [0, 0, 0],
      anisotropy: { elongation: 1, flatness: 1, spread: 1, isStable: false },
    };
  }

  const center = centroid(pts);
  const cov = covariance(pts, center);
  const eigenValues = eigenvaluesSym3(cov);
  const principalAxis = eigenvectorSym3(cov, eigenValues[0]);
  const anisotropy = computeAnisotropy(eigenValues);

  return { center, principalAxis, eigenValues, anisotropy };
}
