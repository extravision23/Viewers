/**
 * BVH acceleration for trajectory raycasting and voxelization.
 */

import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

declare module 'three' {
  interface BufferGeometry {
    boundsTree?: unknown;
    computeBoundsTree?: typeof computeBoundsTree;
    disposeBoundsTree?: typeof disposeBoundsTree;
  }
}

export function collectMeshes(object: THREE.Object3D, meshes: THREE.Mesh[] = []): THREE.Mesh[] {
  object.traverse(child => {
    if (child instanceof THREE.Mesh && child.geometry) {
      meshes.push(child);
    }
  });
  return meshes;
}

export function buildBVH(meshes: THREE.Mesh[]): void {
  for (const mesh of meshes) {
    if (!mesh.geometry) {
      continue;
    }
    if (!mesh.geometry.index) {
      mesh.geometry = mesh.geometry.toNonIndexed();
    }
    mesh.geometry.computeBoundsTree = computeBoundsTree;
    mesh.geometry.disposeBoundsTree = disposeBoundsTree;
    mesh.geometry.computeBoundsTree();
    mesh.raycast = acceleratedRaycast;
  }
}

export function generateMeshId(mesh: THREE.Mesh, index: number): string {
  return mesh.name || `mesh_${index}`;
}
