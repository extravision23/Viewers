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

export async function loadSegmentMeshes(
  artifacts: SegmentMeshArtifact[]
): Promise<{ root: THREE.Group; segments: LoadedSegmentMesh[] }> {
  const loader = new GLTFLoader();
  const root = new THREE.Group();
  const segments: LoadedSegmentMesh[] = [];

  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index];
    const segmentNumber =
      typeof artifact.segmentNumber === 'number' ? artifact.segmentNumber : index + 1;
    const label = artifact.label || `Segment ${segmentNumber}`;

    const gltf = await new Promise<THREE.Group>((resolve, reject) => {
      loader.load(artifact.url, loaded => resolve(loaded.scene), undefined, reject);
    });

    const meshes = collectMeshes(gltf);
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
  }

  buildBVH(segments.map(s => s.mesh));
  return { root, segments };
}
