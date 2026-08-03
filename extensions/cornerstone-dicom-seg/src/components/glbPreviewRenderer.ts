import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  getSurfaceMaterialPreset,
  inferSurfaceMaterialType,
  type SurfaceMaterialType,
} from '@ohif/extension-cornerstone';

export type PreviewPreset = 'clinical' | 'presentation' | 'outline';

export type GlbPreviewRenderOptions = {
  enhancedLighting: boolean;
  ssaoEnabled: boolean;
  exposure: number;
  preset: PreviewPreset;
};

export type TintSceneOptions = {
  anatomyBlend: number;
  preset: PreviewPreset;
  /** Apply brain/CSF/bone/vessel PBR mapping (mirrors VTK surface shaders). */
  tissueShaders?: boolean;
  /** When on, use neutral tissue tones instead of legend/LUT colors (Material preview). */
  materialPreviewColors?: boolean;
  /** Segment label used to infer tissue material type. */
  segmentLabel?: string;
};

/**
 * Richer anatomical base colors for GLB Material preview.
 * VTK viewport lighting is darker; the same linear RGB looked washed-out under
 * Three.js ACES + RoomEnvironment, so these are deeper / more saturated.
 */
const GLB_MATERIAL_PREVIEW_COLORS: Record<SurfaceMaterialType, [number, number, number]> = {
  brain: [0.72, 0.32, 0.3],
  csf: [0.35, 0.62, 0.74],
  bone: [0.82, 0.72, 0.52],
  vessel: [0.62, 0.06, 0.06],
  default: [0.52, 0.48, 0.44],
};

function getGlbPreviewColor(materialType: SurfaceMaterialType): [number, number, number] {
  return GLB_MATERIAL_PREVIEW_COLORS[materialType] ?? GLB_MATERIAL_PREVIEW_COLORS.default;
}

/** Hex color for Material-preview tissue tones (GLB-tuned). */
export function getMaterialPreviewColorHex(segmentLabel?: string): string {
  const materialType = inferSurfaceMaterialType({ label: segmentLabel });
  const [r, g, b] = getGlbPreviewColor(materialType);
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

const DEFAULT_OPTIONS: GlbPreviewRenderOptions = {
  enhancedLighting: true,
  ssaoEnabled: true,
  exposure: 1.1,
  preset: 'presentation',
};

/**
 * Map OHIF Phong surface presets → Three.js MeshPhysicalMaterial knobs.
 * When materialPreviewColors is on, dial back clearcoat/env so colors stay rich
 * instead of washing out to white plastic.
 */
function applyTissueShaderProps(
  physical: THREE.MeshPhysicalMaterial,
  materialType: SurfaceMaterialType,
  materialPreviewColors: boolean
): void {
  const preset = getSurfaceMaterialPreset(materialType);

  // specularPower ≈ shininess; higher → lower roughness
  const roughnessFromSpec =
    preset.specular <= 0.01
      ? 0.92
      : Math.max(0.18, Math.min(0.85, 1 - Math.log2(preset.specularPower + 1) / 7));

  physical.roughness = materialPreviewColors
    ? Math.min(0.72, Math.max(0.28, roughnessFromSpec + 0.12))
    : roughnessFromSpec;
  physical.metalness = 0;
  physical.opacity = preset.opacity;
  physical.transparent = preset.opacity < 0.99;
  physical.depthWrite = preset.opacity >= 0.99;
  // Reset optional PBR knobs before applying a tissue profile.
  physical.clearcoat = 0;
  physical.clearcoatRoughness = 0.45;
  physical.transmission = 0;
  physical.thickness = 0;
  physical.ior = 1.5;
  physical.sheen = 0;
  physical.sheenRoughness = 0.55;
  physical.sheenColor.setRGB(0, 0, 0);
  physical.envMapIntensity = materialPreviewColors ? 0.28 : 0.85;

  switch (materialType) {
    case 'brain':
      physical.clearcoat = materialPreviewColors ? 0.12 : 0.35;
      physical.clearcoatRoughness = materialPreviewColors ? 0.45 : 0.28;
      physical.envMapIntensity = materialPreviewColors ? 0.32 : 0.95;
      physical.sheen = materialPreviewColors ? 0.15 : 0.3;
      physical.sheenRoughness = 0.45;
      physical.sheenColor.setRGB(0.75, 0.28, 0.25);
      break;
    case 'csf':
      // Avoid heavy transmission in preview — it turns layers milky/pale.
      physical.clearcoat = materialPreviewColors ? 0.25 : 0.55;
      physical.clearcoatRoughness = 0.2;
      physical.envMapIntensity = materialPreviewColors ? 0.4 : 1.0;
      physical.transmission = materialPreviewColors ? 0.08 : 0.22;
      physical.thickness = materialPreviewColors ? 0.15 : 0.45;
      physical.ior = 1.33;
      physical.opacity = materialPreviewColors ? Math.max(preset.opacity, 0.55) : preset.opacity;
      physical.transparent = true;
      physical.depthWrite = false;
      break;
    case 'bone':
      physical.envMapIntensity = materialPreviewColors ? 0.18 : 0.35;
      physical.roughness = Math.max(physical.roughness, 0.78);
      break;
    case 'vessel':
      physical.clearcoat = materialPreviewColors ? 0.18 : 0.4;
      physical.clearcoatRoughness = 0.28;
      physical.envMapIntensity = materialPreviewColors ? 0.35 : 0.9;
      physical.sheen = 0.18;
      physical.sheenColor.setRGB(0.55, 0.04, 0.04);
      break;
    default:
      physical.clearcoat = materialPreviewColors ? 0.05 : 0.1;
      physical.clearcoatRoughness = 0.5;
      physical.envMapIntensity = materialPreviewColors ? 0.25 : 0.7;
      break;
  }
}

export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: TrackballControls,
  object: THREE.Object3D
) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxSize = Math.max(size.x, size.y, size.z, 1);
  const fitDistance = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const distance = fitDistance * 1.8;

  camera.position.set(center.x + distance, center.y + distance * 0.5, center.z + distance);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = Math.max(distance * 100, 1000);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  // Keep TrackballControls internal radius in sync after camera moves.
  controls.update();
}

export function storeBakedGrayscale(obj: THREE.Object3D) {
  obj.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.color) {
      return;
    }
    const colors = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const baked = new Float32Array(colors.count);
    for (let i = 0; i < colors.count; i++) {
      baked[i] = colors.getX(i);
    }
    mesh.userData.bakedGray = baked;
  });
}

export function applyClientAnatomyWindow(
  root: THREE.Object3D,
  center: number,
  width: number,
  referenceCenter: number,
  referenceWidth: number
) {
  const refLo = referenceCenter - referenceWidth / 2;
  const refHi = referenceCenter + referenceWidth / 2;
  const lo = center - width / 2;
  const hi = center + width / 2;
  const denom = Math.max(hi - lo, 1e-6);

  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    const baked = mesh.userData?.bakedGray as Float32Array | undefined;
    if (!baked || !mesh.geometry?.attributes?.color) {
      return;
    }
    const attr = mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < baked.length; i++) {
      const hu = refLo + baked[i] * (refHi - refLo);
      const out = Math.max(0, Math.min(1, (hu - lo) / denom));
      attr.setXYZ(i, out, out, out);
    }
    attr.needsUpdate = true;
  });
}

/** Deep-clone a loaded GLTF scene so each segment has its own Object3D (loader may cache by URL). */
export function cloneSegmentScene(source: THREE.Object3D): THREE.Object3D {
  return source.clone(true);
}

export function setSegmentVisibility(root: THREE.Object3D, visible: boolean) {
  root.visible = visible;
}

export function prepareMeshGeometry(obj: THREE.Object3D) {
  obj.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }
    const geometry = mesh.geometry;
    if (!geometry.attributes.normal || geometry.attributes.normal.count === 0) {
      geometry.computeVertexNormals();
    }
  });
}

export function upgradeMaterial(
  material: THREE.Material,
  segmentColor: THREE.Color,
  anatomyBlend: number,
  preset: PreviewPreset,
  hasGeometryVertexColors: boolean,
  tissueOptions?: {
    tissueShaders: boolean;
    materialPreviewColors: boolean;
    materialType: SurfaceMaterialType;
  }
): THREE.MeshPhysicalMaterial {
  const source = material as THREE.MeshStandardMaterial;
  const physical = new THREE.MeshPhysicalMaterial();
  const tissueShaders = tissueOptions?.tissueShaders === true;
  const materialPreviewColors = tissueOptions?.materialPreviewColors === true;
  const materialType = tissueOptions?.materialType ?? 'default';

  // Force flat albedo in material preview — vertex CT colors wash tissue tones to gray/white.
  physical.vertexColors = !materialPreviewColors && anatomyBlend > 0.01 && hasGeometryVertexColors;

  if (source.color) {
    physical.color.copy(source.color);
  }

  if (materialPreviewColors) {
    const [r, g, b] = getGlbPreviewColor(materialType);
    physical.color.setRGB(r, g, b);
  } else {
    physical.color.lerp(segmentColor, Math.max(0, 1 - anatomyBlend));
  }

  if (tissueShaders) {
    applyTissueShaderProps(physical, materialType, materialPreviewColors);
  } else {
    physical.roughness =
      typeof source.roughness === 'number' ? Math.min(Math.max(source.roughness, 0.45), 0.9) : 0.65;
    physical.metalness = typeof source.metalness === 'number' ? Math.min(source.metalness, 0.05) : 0;
    physical.clearcoat = materialPreviewColors ? 0.06 : preset === 'presentation' ? 0.12 : 0;
    physical.clearcoatRoughness = 0.45;
    physical.envMapIntensity = materialPreviewColors
      ? 0.3
      : preset === 'clinical'
        ? 0.6
        : 1.0;
    physical.opacity = materialPreviewColors && materialType === 'csf' ? 0.55 : 1;
    physical.transparent = physical.opacity < 0.99;
    physical.transmission = 0;
    physical.sheen = 0;
  }

  if (preset === 'outline' && !materialPreviewColors) {
    physical.emissive.copy(segmentColor);
    physical.emissiveIntensity = 0.08;
  } else if (materialPreviewColors && materialType === 'brain') {
    // Tiny warm emissive keeps pink brain from going chalky under ACES.
    physical.emissive.setRGB(0.12, 0.03, 0.02);
    physical.emissiveIntensity = 0.12;
  } else {
    physical.emissive.setRGB(0, 0, 0);
    physical.emissiveIntensity = 0;
  }

  return physical;
}

export function tintScene(
  obj: THREE.Object3D,
  colorHex: string,
  anatomyBlendOrOptions: number | TintSceneOptions,
  presetArg?: PreviewPreset
) {
  const options: TintSceneOptions =
    typeof anatomyBlendOrOptions === 'number'
      ? {
          anatomyBlend: anatomyBlendOrOptions,
          preset: presetArg ?? 'presentation',
        }
      : anatomyBlendOrOptions;

  const {
    anatomyBlend,
    preset,
    tissueShaders = false,
    materialPreviewColors = false,
    segmentLabel,
  } = options;

  const segmentColor = new THREE.Color(colorHex);
  const materialType = inferSurfaceMaterialType({ label: segmentLabel });

  obj.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) {
      return;
    }
    const hasGeometryVertexColors = !!mesh.geometry?.attributes?.color;
    const apply = (material: THREE.Material) =>
      upgradeMaterial(material, segmentColor, anatomyBlend, preset, hasGeometryVertexColors, {
        tissueShaders,
        materialPreviewColors,
        materialType,
      });

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(m => {
        const upgraded = apply(m);
        m.dispose();
        return upgraded;
      });
    } else {
      const upgraded = apply(mesh.material);
      mesh.material.dispose();
      mesh.material = upgraded;
    }
  });
}

export type GlbPreviewScene = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: TrackballControls;
  composer: EffectComposer | null;
  ssaoPass: SSAOPass | null;
  pmremGenerator: THREE.PMREMGenerator;
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
  rimLight: THREE.DirectionalLight;
  applyOptions: (options: GlbPreviewRenderOptions) => void;
  resize: (width: number, height: number) => void;
  render: () => void;
  dispose: () => void;
};

export function createGlbPreviewScene(
  mountNode: HTMLElement,
  width: number,
  height: number,
  initialOptions: Partial<GlbPreviewRenderOptions> = {}
): GlbPreviewScene {
  const options: GlbPreviewRenderOptions = { ...DEFAULT_OPTIONS, ...initialOptions };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1b2a);

  const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 5000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setClearColor(0x0d1b2a, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure;
  mountNode.appendChild(renderer.domElement);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const roomEnvironment = new RoomEnvironment();
  const envTexture = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
  scene.environment = envTexture;

  // TrackballControls: free tumble (full 360°) — OrbitControls stops at the poles.
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 4.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.7;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.12;
  controls.noPan = false;
  controls.noZoom = false;
  controls.noRotate = false;

  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xddeeff, 0x1a2433, 0.35);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
  keyLight.position.set(2.5, 4, 2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8db3ff, 0.45);
  fillLight.position.set(-2.5, 0.5, -2);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
  rimLight.position.set(0, 2, -4);
  scene.add(rimLight);

  let composer: EffectComposer | null = null;
  let ssaoPass: SSAOPass | null = null;

  const buildComposer = () => {
    if (composer) {
      composer.dispose();
    }
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    if (options.ssaoEnabled && options.enhancedLighting) {
      ssaoPass = new SSAOPass(scene, camera, width, height);
      ssaoPass.kernelRadius = 8;
      ssaoPass.minDistance = 0.001;
      ssaoPass.maxDistance = 0.12;
      composer.addPass(ssaoPass);
    } else {
      ssaoPass = null;
    }

    composer.addPass(new OutputPass());
  };

  buildComposer();

  const applyPresetLights = (preset: PreviewPreset) => {
    if (preset === 'clinical') {
      keyLight.intensity = 0.85;
      fillLight.intensity = 0.35;
      rimLight.intensity = 0.15;
      ambient.intensity = 0.35;
    } else if (preset === 'outline') {
      keyLight.intensity = 0.7;
      fillLight.intensity = 0.55;
      rimLight.intensity = 0.65;
      ambient.intensity = 0.2;
    } else {
      keyLight.intensity = 1.05;
      fillLight.intensity = 0.45;
      rimLight.intensity = 0.35;
      ambient.intensity = 0.3;
    }
  };

  applyPresetLights(options.preset);

  const applyOptions = (next: GlbPreviewRenderOptions) => {
    Object.assign(options, next);
    renderer.toneMappingExposure = options.exposure;
    scene.environment = options.enhancedLighting ? envTexture : null;
    applyPresetLights(options.preset);
    buildComposer();
  };

  const resize = (w: number, h: number) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    controls.handleResize();
    if (composer) {
      composer.setSize(w, h);
    }
    if (ssaoPass) {
      ssaoPass.setSize(w, h);
    }
  };

  const render = () => {
    if (composer && options.enhancedLighting) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  };

  const dispose = () => {
    controls.dispose();
    composer?.dispose();
    pmremGenerator.dispose();
    envTexture.dispose();
    renderer.dispose();
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    composer,
    ssaoPass,
    pmremGenerator,
    keyLight,
    fillLight,
    rimLight,
    applyOptions,
    resize,
    render,
    dispose,
  };
}
