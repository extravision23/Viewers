/**
 * TrajectoryGenerator — PCA-guided, deterministic cone sampling.
 *
 * Replaces the old random-ray / Fibonacci-sphere sampler.
 *
 * Algorithm:
 *   1. Take PCA principal axis of the hematoma.
 *   2. Build two base directions: +axis and −axis.
 *   3. Around each base, uniformly sample a cone of configurable
 *      half-angle with N deterministic samples (Fibonacci spiral on
 *      the spherical cap).
 *   4. For each direction, raycast toward ENTRY_SURFACE to find the
 *      entry point.
 *   5. Return TrajectoryCandidate[] with entry, direction, length.
 */

import * as THREE from 'three';
import type { PCAResult, TrajectoryCandidate, GeneratorConfig } from '../types';
import { DEFAULT_GENERATOR_CONFIG } from '../types';

// ─── deterministic cone sampling ────────────────────────────────────

/**
 * Generate `n` deterministic, uniformly-distributed directions inside
 * a cone of half-angle `halfAngleRad` around `axis` using the
 * Fibonacci-spiral-on-spherical-cap method.
 *
 * The resulting directions are fully deterministic (no Math.random).
 */
function fibonacciCone(
  axis: THREE.Vector3,
  halfAngleRad: number,
  n: number,
): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [];
  if (n <= 0) return dirs;

  const cosMax = Math.cos(halfAngleRad);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  // Build a rotation that maps (0,0,1) → axis
  const z = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion().setFromUnitVectors(z, axis.clone().normalize());

  for (let i = 0; i < n; i++) {
    // cosθ uniformly in [cosMax, 1]
    const cosTheta = cosMax + (1 - cosMax) * (i / Math.max(n - 1, 1));
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = goldenAngle * i;

    const local = new THREE.Vector3(
      sinTheta * Math.cos(phi),
      sinTheta * Math.sin(phi),
      cosTheta,
    );
    local.applyQuaternion(quat);
    dirs.push(local.normalize());
  }

  return dirs;
}

// ─── entry-point resolution via raycast ─────────────────────────────

/**
 * For a given direction (hematoma centre → outward), cast a ray from
 * the hematoma centre toward the entry surface and return the hit
 * point. Returns null if no intersection.
 */
function resolveEntryPoint(
  center: THREE.Vector3,
  outwardDir: THREE.Vector3,
  entrySurfaceMeshes: THREE.Mesh[],
  maxLength: number,
): { entry: THREE.Vector3; length: number } | null {
  if (entrySurfaceMeshes.length === 0) return null;

  const raycaster = new THREE.Raycaster(center, outwardDir, 0, maxLength);
  const hits = raycaster.intersectObjects(entrySurfaceMeshes, false);

  if (hits.length === 0) return null;

  // Take the outermost hit (last intersection = outer surface)
  const outerHit = hits[hits.length - 1];
  return {
    entry: outerHit.point.clone(),
    length: outerHit.distance,
  };
}

// ─── public API ─────────────────────────────────────────────────────

export interface GeneratorInput {
  pca: PCAResult;
  entrySurfaceMeshes: THREE.Mesh[];
  maxLength: number;
  config?: GeneratorConfig;
}

/**
 * Generate trajectory candidates using PCA-guided deterministic cone
 * sampling.  Each candidate has an entry point on the ENTRY_SURFACE
 * and a direction pointing from entry → hematoma centre.
 */
export function generateCandidates(input: GeneratorInput): TrajectoryCandidate[] {
  const {
    pca,
    entrySurfaceMeshes,
    maxLength,
    config = DEFAULT_GENERATOR_CONFIG,
  } = input;

  const halfAngleRad = (config.coneHalfAngleDeg * Math.PI) / 180;
  const nPerCone = Math.ceil(config.samplesPerCone / 2);

  const candidates: TrajectoryCandidate[] = [];
  const seenKeys = new Set<string>();
  const snapMM = 2; // de-duplicate entries closer than 2 mm

  // Two base directions: +axis and −axis
  const bases = [
    pca.principalAxis.clone().normalize(),
    pca.principalAxis.clone().negate().normalize(),
  ];

  for (const base of bases) {
    const coneDirs = fibonacciCone(base, halfAngleRad, nPerCone);

    for (const outDir of coneDirs) {
      const hit = resolveEntryPoint(pca.center, outDir, entrySurfaceMeshes, maxLength);
      if (!hit) continue;

      // De-duplicate entries on a coarse grid
      const gx = Math.round(hit.entry.x / snapMM);
      const gy = Math.round(hit.entry.y / snapMM);
      const gz = Math.round(hit.entry.z / snapMM);
      const key = `${gx},${gy},${gz}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // Direction: entry → centre (inward)
      const inwardDir = new THREE.Vector3()
        .subVectors(pca.center, hit.entry)
        .normalize();

      candidates.push({
        entry: hit.entry,
        direction: inwardDir,
        length: hit.length,
      });
    }
  }

  return candidates;
}
