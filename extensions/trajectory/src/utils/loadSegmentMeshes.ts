import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildBVH, collectMeshes } from '@extravision/trajectory-planner';
import { inferMeshRoleFromLabel } from '@extravision/trajectory-planner';
import type { MeshRole } from '@extravision/trajectory-planner';

export type SegmentMeshArtifact = {
  url: string;
  label?: string;
  segmentNumber?: number;
};

export type LoadedSegmentMesh = {
  id: string;
  segmentNumber: number;
  label: string;
  mesh: THREE.Mesh;
  defaultRole: MeshRole;
};

function formatGlbLoadError(err: unknown, label: string): string {
  if (err instanceof Error && err.message) {
    return `${label}: ${err.message}`;
  }
  const xhr = err as { status?: number; statusText?: string; responseURL?: string };
  if (typeof xhr?.status === 'number') {
    return `${label}: HTTP ${xhr.status} ${xhr.statusText || ''}`.trim();
  }
  return `${label}: failed to load GLB`;
}

export async function loadSegmentMeshes(
  artifacts: SegmentMeshArtifact[]
): Promise<{ root: THREE.Group; segments: LoadedSegmentMesh[] }> {
  const loader = new GLTFLoader();
  const root = new THREE.Group();
  const segments: LoadedSegmentMesh[] = [];
  const loadErrors: string[] = [];

  await Promise.all(
    artifacts.map(
      (artifact, index) =>
        new Promise<void>(resolve => {
          const segmentNumber =
            typeof artifact.segmentNumber === 'number' ? artifact.segmentNumber : index + 1;
          const label = artifact.label || `Segment ${segmentNumber}`;

          if (!artifact.url) {
            loadErrors.push(`${label}: missing URL`);
            resolve();
            return;
          }

          loader.load(
            artifact.url,
            gltf => {
              const meshes = collectMeshes(gltf.scene);
              meshes.forEach((mesh, meshIndex) => {
                mesh.name = label;
                root.add(mesh);
                segments.push({
                  id: `seg-${segmentNumber}-${meshIndex}`,
                  segmentNumber,
                  label,
                  mesh,
                  defaultRole: inferMeshRoleFromLabel(label),
                });
              });
              resolve();
            },
            undefined,
            err => {
              // Never reject with raw XMLHttpRequest — that floods the error overlay.
              loadErrors.push(formatGlbLoadError(err, label));
              resolve();
            }
          );
        })
    )
  );

  if (!segments.length) {
    throw new Error(
      loadErrors.length
        ? `No segment meshes loaded. ${loadErrors.slice(0, 5).join('; ')}`
        : 'No segment meshes loaded.'
    );
  }

  if (loadErrors.length) {
    console.warn('[loadSegmentMeshes] some GLBs failed:', loadErrors);
  }

  buildBVH(segments.map(s => s.mesh));
  return { root, segments };
}
