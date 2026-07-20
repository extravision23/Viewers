import { Types } from '@cornerstonejs/core';
import { segmentation as cstSegmentation } from '@cornerstonejs/tools';

/**
 * Anatomical material presets for 3D surface segment meshes.
 *
 * Differences are intentionally strong (Phong + simple post-light color grade)
 * so brain / CSF / bone / vessel read apart even without true PBR/SSS.
 * GLSL avoids depending on normals so it still works if Shade was off when the
 * shader was first compiled (we force Shade on via the property path).
 *
 * Optional "material preview" mode replaces rainbow LUT colors with neutral
 * tissue tones so lighting/shader differences are easier to see.
 */
export type SurfaceMaterialType = 'brain' | 'csf' | 'bone' | 'vessel' | 'default';

type PhongProperty = {
  setShade?: (v: boolean) => void;
  setAmbient?: (v: number) => void;
  setDiffuse?: (v: number) => void;
  setSpecular?: (v: number) => void;
  setSpecularPower?: (v: number) => void;
  setOpacity?: (v: number) => void;
  setInterpolationToPhong?: () => void;
  setLighting?: (v: boolean) => void;
  setColor?: (r: number, g: number, b: number) => void;
  setSpecularColor?: (r: number, g: number, b: number) => void;
  setDiffuseColor?: (r: number, g: number, b: number) => void;
  setAmbientColor?: (r: number, g: number, b: number) => void;
};

type MaterialPreset = {
  ambient: number;
  diffuse: number;
  specular: number;
  specularPower: number;
  opacity: number;
  /** Neutral base RGB (0–1) used when material-preview colors are on. */
  previewColor: [number, number, number];
  /** GLSL appended after VTK Phong (//VTK::Light::Impl). */
  fragmentPostLight: string;
};

function buildGradeShader(
  tint: [number, number, number],
  add: [number, number, number],
  mixAmount: number
): string {
  return `
  //VTK::Light::Impl
  {
    vec3 tinted = gl_FragData[0].rgb * vec3(${tint[0]}, ${tint[1]}, ${tint[2]})
                + vec3(${add[0]}, ${add[1]}, ${add[2]});
    gl_FragData[0].rgb = mix(gl_FragData[0].rgb, tinted, ${mixAmount.toFixed(2)});
  }
`;
}

const MATERIAL_PRESETS: Record<SurfaceMaterialType, MaterialPreset> = {
  brain: {
    ambient: 0.08,
    diffuse: 0.55,
    specular: 1.0,
    specularPower: 64,
    opacity: 1,
    previewColor: [0.82, 0.62, 0.58],
    fragmentPostLight: buildGradeShader([1.15, 0.72, 0.68], [0.08, 0.02, 0.02], 0.7),
  },
  csf: {
    ambient: 0.15,
    diffuse: 0.45,
    specular: 1.0,
    specularPower: 80,
    opacity: 0.5,
    previewColor: [0.72, 0.88, 0.92],
    fragmentPostLight: buildGradeShader([0.75, 1.15, 1.25], [0.12, 0.14, 0.16], 0.75),
  },
  bone: {
    ambient: 0.45,
    diffuse: 0.85,
    specular: 0.0,
    specularPower: 1,
    opacity: 1,
    previewColor: [0.9, 0.86, 0.76],
    fragmentPostLight: buildGradeShader([1.05, 1.0, 0.88], [-0.05, -0.05, -0.08], 0.8),
  },
  vessel: {
    ambient: 0.08,
    diffuse: 0.55,
    specular: 0.7,
    specularPower: 36,
    opacity: 0.6,
    previewColor: [0.72, 0.18, 0.18],
    fragmentPostLight: buildGradeShader([1.45, 0.25, 0.25], [0.12, 0.0, 0.0], 0.85),
  },
  default: {
    ambient: 0.25,
    diffuse: 0.75,
    specular: 0.2,
    specularPower: 12,
    opacity: 1,
    previewColor: [0.7, 0.7, 0.68],
    fragmentPostLight: buildGradeShader([1.0, 1.0, 1.0], [0.0, 0.0, 0.0], 0.0),
  },
};

const SURFACE_UID_RE = /^(.*)-Surface-(\d+)$/;

/**
 * Feature flag: custom GLSL surface materials.
 * Enabled by default; set localStorage `ohif.surfaceMaterialShaders` to `0` to disable.
 */
export function areSurfaceMaterialShadersEnabled(): boolean {
  try {
    if (typeof window === 'undefined') {
      return true;
    }
    const flag = window.localStorage?.getItem('ohif.surfaceMaterialShaders');
    if (flag === '0' || flag === 'false') {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Whether rainbow LUT colors are replaced with neutral material tones. */
export function isSurfaceMaterialPreviewColorsEnabled(
  viewport: Types.IVolumeViewport
): boolean {
  return Boolean(viewport.__surfaceMaterialPreviewColors);
}

export function setSurfaceMaterialPreviewColors(
  viewport: Types.IVolumeViewport,
  enabled: boolean
): void {
  viewport.__surfaceMaterialPreviewColors = enabled;
  applySurfaceMaterialShaders(viewport);
  viewport.render();
}

const SEGMENT_LABEL_MATERIAL: Record<string, SurfaceMaterialType> = {
  brainstem: 'brain',
  septum_pellucidum: 'brain',
  cerebellum: 'brain',
  caudate_nucleus: 'brain',
  lentiform_nucleus: 'brain',
  insular_cortex: 'brain',
  internal_capsule: 'brain',
  central_sulcus: 'brain',
  frontal_lobe: 'brain',
  parietal_lobe: 'brain',
  occipital_lobe: 'brain',
  temporal_lobe: 'brain',
  thalamus: 'brain',
  cortex: 'brain',
  grey_matter: 'brain',
  gray_matter: 'brain',
  white_matter: 'brain',
  brain: 'brain',
  cerebrum: 'brain',
  subarachnoid_space: 'csf',
  ventricle: 'csf',
  ventricles: 'csf',
  csf: 'csf',
  venous_sinuses: 'vessel',
  venous_sinus: 'vessel',
  vessel: 'vessel',
  vessels: 'vessel',
  artery: 'vessel',
  arteries: 'vessel',
  vein: 'vessel',
  veins: 'vessel',
  aorta: 'vessel',
  carotid: 'vessel',
  cta_vessels: 'vessel',
  bone: 'bone',
  skull: 'bone',
  cranium: 'bone',
  vertebra: 'bone',
  mandible: 'bone',
};

function normalizeSegmentLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');
}

export function inferSurfaceMaterialType(segment?: {
  label?: string;
  cachedStats?: { type?: string; category?: string };
}): SurfaceMaterialType {
  const candidates = [segment?.label, segment?.cachedStats?.type, segment?.cachedStats?.category]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSegmentLabel);

  for (const key of candidates) {
    if (SEGMENT_LABEL_MATERIAL[key]) {
      return SEGMENT_LABEL_MATERIAL[key];
    }
  }

  const text = candidates.join(' ');
  if (!text) {
    return 'default';
  }

  if (/^class_\d+$/.test(text) || /\bclass_\d+\b/.test(text)) {
    return 'default';
  }

  if (
    /\b(vessel|artery|vein|venous|sinus|vascular|aorta|carotid|cta|blood)\b/.test(text) ||
    text.includes('cta_vessels') ||
    text.includes('venous_sinus')
  ) {
    return 'vessel';
  }

  if (/\b(bone|skull|vertebra|rib|cranium|mandible|ivory)\b/.test(text)) {
    return 'bone';
  }

  if (/\b(ventricle|csf|subarachnoid|cistern)\b/.test(text) || text.includes('subarachnoid')) {
    return 'csf';
  }

  if (
    /\b(brain|brainstem|cerebr|cerebel|thalamus|caudate|lentiform|insula|capsule|sulcus|lobe|nucleus|cortex|dura|encephalon|septum)\b/.test(
      text
    ) ||
    text.includes('brain_csf') ||
    text.includes('_lobe') ||
    text.includes('_cortex') ||
    text.includes('_nucleus')
  ) {
    return 'brain';
  }

  return 'default';
}

function parseSurfaceRepresentationUID(representationUID: string): {
  segmentationId: string;
  segmentIndex: number;
} | null {
  const match = representationUID.match(SURFACE_UID_RE);
  if (!match) {
    return null;
  }
  return {
    segmentationId: match[1],
    segmentIndex: Number(match[2]),
  };
}

function ensureOpenGLSpec(mapper: {
  getViewSpecificProperties?: () => Record<string, unknown>;
}): {
  OpenGL: {
    ShaderReplacements: Array<Record<string, unknown>>;
  };
  __ohifMaterialType?: SurfaceMaterialType;
} | null {
  const props = mapper.getViewSpecificProperties?.();
  if (!props) {
    return null;
  }
  if (!props.OpenGL) {
    props.OpenGL = {
      ShaderReplacements: [],
      VertexShaderCode: '',
      FragmentShaderCode: '',
      GeometryShaderCode: '',
    };
  }
  const openGL = props.OpenGL as {
    ShaderReplacements?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(openGL.ShaderReplacements)) {
    openGL.ShaderReplacements = [];
  }
  return props as {
    OpenGL: { ShaderReplacements: Array<Record<string, unknown>> };
    __ohifMaterialType?: SurfaceMaterialType;
  };
}

function applyMaterialProperty(property: PhongProperty, preset: MaterialPreset): void {
  property.setLighting?.(true);
  property.setShade?.(true);
  property.setAmbient?.(preset.ambient);
  property.setDiffuse?.(preset.diffuse);
  property.setSpecular?.(preset.specular);
  property.setSpecularPower?.(preset.specularPower);
  property.setOpacity?.(preset.opacity);
  property.setInterpolationToPhong?.();
}

/**
 * vtkProperty.setColor() also copies the RGB into specularColor, which makes
 * highlights the same hue as the tissue and nearly invisible. Restore a white
 * specular lobe for glossy materials after any setColor call.
 */
function applySpecularHighlightColor(property: PhongProperty, materialType: SurfaceMaterialType): void {
  if (materialType === 'bone' || materialType === 'default') {
    // Matte: keep specularColor muted (matches base via setColor).
    return;
  }
  property.setSpecularColor?.(1, 1, 1);
}

function applyActorColor(
  property: PhongProperty,
  viewportId: string,
  segmentationId: string,
  segmentIndex: number,
  preset: MaterialPreset,
  previewColors: boolean,
  materialType: SurfaceMaterialType
): void {
  if (previewColors) {
    const [r, g, b] = preset.previewColor;
    property.setColor?.(r, g, b);
    applySpecularHighlightColor(property, materialType);
    return;
  }

  try {
    const lutColor = cstSegmentation.config.color.getSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex
    );
    if (lutColor && lutColor.length >= 3) {
      property.setColor?.(lutColor[0] / 255, lutColor[1] / 255, lutColor[2] / 255);
      applySpecularHighlightColor(property, materialType);
    }
  } catch {
    // Color LUT may be unavailable for transient actors.
  }
}

function applyMaterialShader(
  mapper: {
    getViewSpecificProperties?: () => Record<string, unknown>;
    modified?: () => void;
  },
  materialType: SurfaceMaterialType
): void {
  const props = ensureOpenGLSpec(mapper);
  if (!props) {
    return;
  }

  const preset = MATERIAL_PRESETS[materialType];
  props.OpenGL.ShaderReplacements = props.OpenGL.ShaderReplacements.filter(
    entry => entry?.__ohifSurfaceMaterial !== true
  );
  props.OpenGL.ShaderReplacements.push({
    __ohifSurfaceMaterial: true,
    shaderType: 'Fragment',
    originalValue: '//VTK::Light::Impl',
    replaceFirst: false,
    replacementValue: preset.fragmentPostLight,
    replaceAll: false,
  });
  props.__ohifMaterialType = materialType;
  mapper.modified?.();
}

let didLogMaterialSummary = false;

/**
 * Applies per-structure Phong + post-lighting GLSL to every surface segment
 * actor on a 3D viewport (brain / csf / bone / vessel / default).
 */
export function applySurfaceMaterialShaders(viewport: Types.IVolumeViewport): void {
  if (!areSurfaceMaterialShadersEnabled()) {
    return;
  }

  const previewColors = isSurfaceMaterialPreviewColorsEnabled(viewport);
  const counts: Partial<Record<SurfaceMaterialType, number>> = {};

  viewport.getActors().forEach(entry => {
    const { actor, representationUID } = entry as Types.ActorEntry & {
      representationUID?: string;
    };
    if (!representationUID) {
      return;
    }
    const isMesh =
      typeof (actor as unknown as { isA?: (name: string) => boolean }).isA === 'function' &&
      (actor as unknown as { isA: (name: string) => boolean }).isA('vtkActor');
    if (!isMesh) {
      return;
    }

    const parsed = parseSurfaceRepresentationUID(representationUID);
    const segmentation = parsed
      ? cstSegmentation.state.getSegmentation(parsed.segmentationId)
      : undefined;
    const segment = parsed ? segmentation?.segments?.[parsed.segmentIndex] : undefined;
    const materialType = inferSurfaceMaterialType(segment);
    const preset = MATERIAL_PRESETS[materialType];
    counts[materialType] = (counts[materialType] ?? 0) + 1;

    const property = (actor as unknown as { getProperty?: () => PhongProperty }).getProperty?.();
    if (property) {
      applyMaterialProperty(property, preset);
      if (parsed) {
        applyActorColor(
          property,
          viewport.id,
          parsed.segmentationId,
          parsed.segmentIndex,
          preset,
          previewColors,
          materialType
        );
      } else if (previewColors) {
        const [r, g, b] = preset.previewColor;
        property.setColor?.(r, g, b);
        applySpecularHighlightColor(property, materialType);
      }
    }

    const mapper = (actor as unknown as { getMapper?: () => unknown }).getMapper?.() as
      | {
          getViewSpecificProperties?: () => Record<string, unknown>;
          modified?: () => void;
        }
      | undefined;
    if (mapper) {
      applyMaterialShader(mapper, materialType);
    }
  });

  if (!didLogMaterialSummary && Object.keys(counts).length) {
    didLogMaterialSummary = true;
    console.info('[OHIF] Surface material shaders applied:', counts);
  }
}
