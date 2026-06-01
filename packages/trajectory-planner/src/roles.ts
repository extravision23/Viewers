/**
 * Mesh roles for trajectory planning (shared by core voxel pipeline and UI).
 */

export type MeshRole = 'ENTRY_SURFACE' | 'TARGET' | 'OBSTACLE' | 'CONTEXT' | 'IGNORE';
export type ObstacleSubtype = 'vessel' | 'ventricle' | 'sinus' | 'other';

export const OBSTACLE_SUBTYPES: ObstacleSubtype[] = ['vessel', 'ventricle', 'sinus', 'other'];

/**
 * Infer an obstacle subtype from a mesh/segment name (case-insensitive).
 */
export function inferObstacleSubtype(meshName: string): ObstacleSubtype {
  const n = meshName.toLowerCase();
  if (
    n.includes('vessel') ||
    n.includes('artery') ||
    n.includes('arteries') ||
    n.includes('vein') ||
    n.includes('veins') ||
    n.includes('vascular')
  ) {
    return 'vessel';
  }
  if (n.includes('ventricle') || n.includes('ventricles') || n.includes('vent')) {
    return 'ventricle';
  }
  if (
    n.includes('sinus') ||
    n.includes('sinuses') ||
    n.includes('sagittal') ||
    n.includes('transverse')
  ) {
    return 'sinus';
  }
  return 'other';
}

/**
 * Default mesh role from segment label (OHIF / DICOM segment names).
 */
export function inferMeshRoleFromLabel(label: string): MeshRole {
  const n = label.toLowerCase();
  if (
    n.includes('hematoma') ||
    n.includes('hemorrhage') ||
    n.includes('ich') ||
    n.includes('bleed') ||
    n.includes('lesion') ||
    n.includes('target') ||
    n.includes('tumor')
  ) {
    return 'TARGET';
  }
  if (
    n.includes('skull') ||
    n.includes('scalp') ||
    n.includes('skin') ||
    n.includes('bone') ||
    n.includes('entry') ||
    n.includes('cranium')
  ) {
    return 'ENTRY_SURFACE';
  }
  if (
    n.includes('vessel') ||
    n.includes('ventricle') ||
    n.includes('sinus') ||
    n.includes('artery') ||
    n.includes('vein') ||
    n.includes('vent')
  ) {
    return 'OBSTACLE';
  }
  if (n.includes('brain') || n.includes('parenchyma') || n.includes('context')) {
    return 'CONTEXT';
  }
  return 'CONTEXT';
}
