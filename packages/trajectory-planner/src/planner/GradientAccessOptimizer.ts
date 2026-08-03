/**
 * GradientAccessOptimizer — continuous access-path search.
 *
 * Tip is fixed at the hematoma PCA centre. Direction is parametrized
 * by spherical angles (θ, φ) in the PCA frame. For each (θ, φ) we
 * raycast outward to ENTRY_SURFACE, then minimise:
 *
 *   J = wL·L_norm + wD·P_norm + wA·A_norm   (+ HARD_PENALTY if blocked)
 *
 * via finite-difference gradient descent with multi-start seeds:
 *   ±PCA, shortest full-sphere ipsilateral entries, cone survivors.
 */

import * as THREE from 'three';
import type {
  PCAResult,
  TrajectoryCandidate,
  ScoredTrajectory,
  ScoringCoefficients,
  GradientDescentConfig,
  DistanceFieldSet,
  VoxelMasks,
} from '../types';
import {
  DEFAULT_COEFFICIENTS,
  DEFAULT_GRADIENT_CONFIG,
  SKIN_DISTANCE_REF_MM,
  TRAJECTORY_LENGTH_REF_MM,
} from '../types';
import { resolveEntryPoint } from './TrajectoryGenerator';
import { violatesHardConstraints, scoreTrajectory } from './TrajectoryEvaluator';

const HARD_PENALTY = 1e6;

interface PcaFrame {
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}

function buildPcaFrame(pc1: THREE.Vector3): PcaFrame {
  const z = pc1.clone().normalize();
  const tmp = Math.abs(z.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(tmp, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return { x, y, z };
}

function outwardToAngles(out: THREE.Vector3, frame: PcaFrame): { theta: number; phi: number } {
  const n = out.clone().normalize();
  const lz = Math.max(-1, Math.min(1, n.dot(frame.z)));
  const lx = n.dot(frame.x);
  const ly = n.dot(frame.y);
  return {
    theta: Math.acos(lz),
    phi: Math.atan2(ly, lx),
  };
}

function anglesToOutward(theta: number, phi: number, frame: PcaFrame): THREE.Vector3 {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  return frame.x
    .clone()
    .multiplyScalar(st * cp)
    .add(frame.y.clone().multiplyScalar(st * sp))
    .add(frame.z.clone().multiplyScalar(ct))
    .normalize();
}

/** Deterministic Fibonacci sphere directions. */
function fibonacciSphere(n: number): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [];
  if (n <= 0) return dirs;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(n - 1, 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = golden * i;
    dirs.push(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r).normalize());
  }
  return dirs;
}

function candidateFromOutward(
  center: THREE.Vector3,
  outward: THREE.Vector3,
  entrySurfaceMeshes: THREE.Mesh[],
  maxLength: number,
): TrajectoryCandidate | null {
  const hit = resolveEntryPoint(center, outward, entrySurfaceMeshes, maxLength);
  if (!hit) return null;
  const direction = new THREE.Vector3().subVectors(center, hit.entry).normalize();
  return { entry: hit.entry, direction, length: hit.length };
}

function softLengthNorm(lengthMm: number): number {
  return 1 - Math.exp(-lengthMm / TRAJECTORY_LENGTH_REF_MM);
}

function softSkinNorm(distMm: number): number {
  return 1 - Math.exp(-distMm / SKIN_DISTANCE_REF_MM);
}

export interface AccessCostContext {
  masks: VoxelMasks;
  dilatedMasks?: VoxelMasks;
  distanceFields: DistanceFieldSet;
  coefficients: ScoringCoefficients;
  pca: PCAResult;
  hematomaVoxelCount: number;
}

/**
 * Cost to minimise (lower = better). Hard-blocked paths get HARD_PENALTY.
 */
export function evaluateAccessCost(
  candidate: TrajectoryCandidate,
  ctx: AccessCostContext,
): { cost: number; blocked: boolean; scored: ScoredTrajectory } {
  const blocked = violatesHardConstraints(candidate, ctx.masks, ctx.dilatedMasks);
  const scored = scoreTrajectory(candidate, {
    masks: ctx.masks,
    coefficients: ctx.coefficients,
    distanceFields: ctx.distanceFields,
    hematomaVoxelCount: ctx.hematomaVoxelCount,
    dilatedMasks: ctx.dilatedMasks,
    pca: ctx.pca,
  });

  const bd = scored.scoreBreakdown;
  const wL = ctx.coefficients.delta;
  const wD = ctx.coefficients.gamma;
  const wA = ctx.coefficients.epsilon ?? DEFAULT_COEFFICIENTS.epsilon;
  const wSkin = ctx.coefficients.beta;

  // Minimise length + clearance risk + angle deviation + extracerebral path.
  // Coverage is intentionally omitted from J (access planning).
  let cost =
    wL * softLengthNorm(candidate.length) +
    wSkin * softSkinNorm(bd.dSkinRaw) +
    wD * bd.proximityNorm +
    wA * bd.angleNorm;

  if (blocked) cost += HARD_PENALTY;

  return { cost, blocked, scored };
}

function refineSeed(
  seedOutward: THREE.Vector3,
  frame: PcaFrame,
  center: THREE.Vector3,
  entrySurfaceMeshes: THREE.Mesh[],
  maxLength: number,
  ctx: AccessCostContext,
  gd: GradientDescentConfig,
): { candidate: TrajectoryCandidate; cost: number; blocked: boolean; scored: ScoredTrajectory } | null {
  let { theta, phi } = outwardToAngles(seedOutward, frame);
  let best: ReturnType<typeof evaluateAccessCost> & { candidate: TrajectoryCandidate } | null = null;

  const evalAngles = (th: number, ph: number) => {
    const out = anglesToOutward(th, ph, frame);
    const cand = candidateFromOutward(center, out, entrySurfaceMeshes, maxLength);
    if (!cand) return null;
    const ev = evaluateAccessCost(cand, ctx);
    return { candidate: cand, ...ev };
  };

  const start = evalAngles(theta, phi);
  if (start) best = start;

  for (let iter = 0; iter < gd.maxIterations; iter++) {
    const eps = gd.fdEpsilon;
    const c0 = evalAngles(theta, phi);
    if (!c0) break;

    const cThetaP = evalAngles(theta + eps, phi);
    const cThetaM = evalAngles(theta - eps, phi);
    const cPhiP = evalAngles(theta, phi + eps);
    const cPhiM = evalAngles(theta, phi - eps);

    const dTheta =
      cThetaP && cThetaM
        ? (cThetaP.cost - cThetaM.cost) / (2 * eps)
        : cThetaP
          ? (cThetaP.cost - c0.cost) / eps
          : cThetaM
            ? (c0.cost - cThetaM.cost) / eps
            : 0;
    const dPhi =
      cPhiP && cPhiM
        ? (cPhiP.cost - cPhiM.cost) / (2 * eps)
        : cPhiP
          ? (cPhiP.cost - c0.cost) / eps
          : cPhiM
            ? (c0.cost - cPhiM.cost) / eps
            : 0;

    theta -= gd.learningRate * dTheta;
    phi -= gd.learningRate * dPhi;
    // Keep theta in (0, π)
    theta = Math.max(1e-4, Math.min(Math.PI - 1e-4, theta));

    const next = evalAngles(theta, phi);
    if (!next) continue;
    if (!best || next.cost < best.cost) {
      best = next;
    }
  }

  return best;
}

export interface GradientOptimizeInput {
  pca: PCAResult;
  entrySurfaceMeshes: THREE.Mesh[];
  maxLength: number;
  ctx: AccessCostContext;
  gradient?: GradientDescentConfig;
  /** Optional pre-generated cone candidates used as extra seeds. */
  coneCandidates?: TrajectoryCandidate[];
}

export interface GradientOptimizeResult {
  feasible: ScoredTrajectory[];
  bestInfeasible: ScoredTrajectory | null;
  stats: {
    seedsTried: number;
    feasibleFound: number;
    sphereHits: number;
  };
}

/**
 * Multi-start gradient descent over access angles from the hematoma centre.
 */
export function optimizeAccessByGradient(input: GradientOptimizeInput): GradientOptimizeResult {
  const gd = { ...DEFAULT_GRADIENT_CONFIG, ...input.gradient };
  const { pca, entrySurfaceMeshes, maxLength, ctx } = input;
  const frame = buildPcaFrame(pca.principalAxis);
  const center = pca.center;

  const seedOutwards: THREE.Vector3[] = [];
  const pushUnique = (dir: THREE.Vector3) => {
    const n = dir.clone().normalize();
    for (const existing of seedOutwards) {
      if (existing.dot(n) > 0.998) return;
    }
    seedOutwards.push(n);
  };

  // ±PCA
  pushUnique(pca.principalAxis);
  pushUnique(pca.principalAxis.clone().negate());

  // Ipsilateral / short-path seeds from full-sphere sampling
  const sphereDirs = fibonacciSphere(gd.sphereSeedSamples);
  const sphereHits: { outward: THREE.Vector3; length: number }[] = [];
  for (const out of sphereDirs) {
    const hit = resolveEntryPoint(center, out, entrySurfaceMeshes, maxLength);
    if (!hit) continue;
    sphereHits.push({ outward: out, length: hit.length });
  }
  sphereHits.sort((a, b) => a.length - b.length);
  for (const h of sphereHits.slice(0, gd.ipsilateralSeedCount)) {
    pushUnique(h.outward);
  }

  // Cone survivors as seeds (already point entry→center; invert to outward)
  if (input.coneCandidates) {
    for (const c of input.coneCandidates) {
      pushUnique(new THREE.Vector3().subVectors(c.entry, center));
    }
  }

  const starts = seedOutwards.slice(0, gd.maxStarts);
  const feasible: ScoredTrajectory[] = [];
  let bestInfeasible: ScoredTrajectory | null = null;
  let bestInfeasibleCost = Infinity;

  for (const seed of starts) {
    const refined = refineSeed(seed, frame, center, entrySurfaceMeshes, maxLength, ctx, gd);
    if (!refined) continue;

    if (!refined.blocked) {
      feasible.push(refined.scored);
    } else if (refined.cost < bestInfeasibleCost) {
      bestInfeasibleCost = refined.cost;
      bestInfeasible = refined.scored;
    }
  }

  // Prefer shorter among near-equal scores
  feasible.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-4) return scoreDiff;
    const extraDiff = a.distSkinToHematoma - b.distSkinToHematoma;
    if (Math.abs(extraDiff) > 0.05) return extraDiff;
    return a.length - b.length;
  });

  // Deduplicate near-identical entries
  const unique: ScoredTrajectory[] = [];
  const seen = new Set<string>();
  for (const t of feasible) {
    const key = `${Math.round(t.entry.x)},${Math.round(t.entry.y)},${Math.round(t.entry.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  return {
    feasible: unique,
    bestInfeasible,
    stats: {
      seedsTried: starts.length,
      feasibleFound: unique.length,
      sphereHits: sphereHits.length,
    },
  };
}
