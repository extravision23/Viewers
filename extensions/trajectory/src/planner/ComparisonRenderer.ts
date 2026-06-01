/**
 * ComparisonRenderer — persistent blue (manual) and green (AI)
 * trajectory lines that remain visible in the scene for side-by-side
 * comparison, independent of the editable TrajectoryTool.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const MANUAL_COLOR = 0x4488ff;
const AI_COLOR = 0x44dd88;
const LINE_WIDTH = 4;
const MARKER_RADIUS = 1.8;

interface TrajectoryVisual {
  line: Line2;
  lineMat: LineMaterial;
  lineGeo: LineGeometry;
  marker: THREE.Mesh;
  markerMat: THREE.MeshBasicMaterial;
}

function createVisual(color: number, dashed: boolean): TrajectoryVisual {
  const lineGeo = new LineGeometry();
  lineGeo.setPositions([0, 0, 0, 0, 0, 1]);

  const lineMat = new LineMaterial({
    color,
    linewidth: LINE_WIDTH,
    dashed,
    dashScale: dashed ? 3 : 1,
    dashSize: dashed ? 2 : 1,
    gapSize: dashed ? 1 : 0,
    transparent: true,
    opacity: 0.85,
    depthTest: true,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
  });

  const line = new Line2(lineGeo, lineMat);
  line.computeLineDistances();
  line.renderOrder = 200;
  line.visible = false;

  const markerMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
  });
  const marker = new THREE.Mesh(new THREE.SphereGeometry(MARKER_RADIUS, 12, 8), markerMat);
  marker.renderOrder = 201;
  marker.visible = false;

  return { line, lineMat, lineGeo, marker, markerMat };
}

function updateVisual(
  vis: TrajectoryVisual,
  entry: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
): void {
  const end = entry.clone().add(direction.clone().normalize().multiplyScalar(length));
  vis.lineGeo.setPositions([entry.x, entry.y, entry.z, end.x, end.y, end.z]);
  vis.line.computeLineDistances();
  vis.line.visible = true;
  vis.marker.position.copy(entry);
  vis.marker.visible = true;
}

function hideVisual(vis: TrajectoryVisual): void {
  vis.line.visible = false;
  vis.marker.visible = false;
}

function disposeVisual(vis: TrajectoryVisual): void {
  vis.lineGeo.dispose();
  vis.lineMat.dispose();
  vis.markerMat.dispose();
  (vis.marker.geometry as THREE.SphereGeometry).dispose();
}

export class ComparisonRenderer {
  private scene: THREE.Scene;
  private group: THREE.Group;
  private manual: TrajectoryVisual;
  private ai: TrajectoryVisual;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = '__comparison_overlay';

    this.manual = createVisual(MANUAL_COLOR, true);
    this.ai = createVisual(AI_COLOR, false);

    this.group.add(this.manual.line, this.manual.marker);
    this.group.add(this.ai.line, this.ai.marker);
    this.scene.add(this.group);
  }

  setManualTrajectory(entry: THREE.Vector3, direction: THREE.Vector3, length: number): void {
    updateVisual(this.manual, entry, direction, length);
  }

  setAiTrajectory(entry: THREE.Vector3, direction: THREE.Vector3, length: number): void {
    updateVisual(this.ai, entry, direction, length);
  }

  clearManual(): void {
    hideVisual(this.manual);
  }

  clearAi(): void {
    hideVisual(this.ai);
  }

  clearAll(): void {
    this.clearManual();
    this.clearAi();
  }

  /** Update LineMaterial resolution on window resize. */
  updateResolution(width: number, height: number): void {
    this.manual.lineMat.resolution.set(width, height);
    this.ai.lineMat.resolution.set(width, height);
  }

  dispose(): void {
    this.clearAll();
    disposeVisual(this.manual);
    disposeVisual(this.ai);
    this.scene.remove(this.group);
  }
}
