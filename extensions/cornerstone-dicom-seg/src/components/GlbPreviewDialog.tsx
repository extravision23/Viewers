import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  createGlbPreviewScene,
  cloneSegmentScene,
  fitCameraToObject,
  prepareMeshGeometry,
  setSegmentVisibility,
  tintScene,
  applyClientAnatomyWindow,
  storeBakedGrayscale,
  tintScene as applyTintScene,
  type PreviewPreset,
} from './glbPreviewRenderer';

type PreviewModel = {
  url: string;
  label?: string;
  segmentNumber?: number;
};

type GlbPreviewDialogProps = {
  hide?: () => void;
  modelUrl?: string;
  models?: PreviewModel[];
  title?: string;
  onRegenerate?: () => void;
  isRegenerating?: boolean;
  anatomyWindow?: { center: number; width: number };
};

type LegendItem = {
  id: string;
  color: string;
  label: string;
  visible: boolean;
};

const COLOR_PALETTE = [
  '#ef4444',
  '#22c55e',
  '#3b82f6',
  '#eab308',
  '#a855f7',
  '#14b8a6',
  '#f97316',
  '#ec4899',
  '#84cc16',
  '#06b6d4',
  '#f43f5e',
  '#8b5cf6',
];

export default function GlbPreviewDialog({
  hide,
  modelUrl,
  models,
  title,
  onRegenerate,
  isRegenerating = false,
  anatomyWindow = { center: 40, width: 400 },
}: GlbPreviewDialogProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const segmentNodesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const segmentColorsRef = useRef<Map<THREE.Object3D, string>>(new Map());
  const rootGroupRef = useRef<THREE.Group | null>(null);
  const previewSceneRef = useRef<ReturnType<typeof createGlbPreviewScene> | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [legendItems, setLegendItems] = useState<LegendItem[]>([]);
  const [enhancedLighting, setEnhancedLighting] = useState(true);
  const [ssaoEnabled, setSsaoEnabled] = useState(true);
  const [anatomyBlend, setAnatomyBlend] = useState(0.35);
  const [exposure, setExposure] = useState(1.1);
  const [preset, setPreset] = useState<PreviewPreset>('presentation');
  const [hasVertexColors, setHasVertexColors] = useState(false);
  const [sceneMeshCount, setSceneMeshCount] = useState(0);
  const [windowCenter, setWindowCenter] = useState(anatomyWindow.center);
  const [windowWidth, setWindowWidth] = useState(anatomyWindow.width);
  const referenceWindowRef = useRef(anatomyWindow);
  const segmentVisibilityRef = useRef<Map<string, boolean>>(new Map());

  const resolvedModels: PreviewModel[] = useMemo(
    () => (Array.isArray(models) ? models : modelUrl ? [{ url: modelUrl }] : []).filter(m => !!m?.url),
    [models, modelUrl]
  );

  useEffect(() => {
    referenceWindowRef.current = anatomyWindow;
    setWindowCenter(anatomyWindow.center);
    setWindowWidth(anatomyWindow.width);
  }, [anatomyWindow.center, anatomyWindow.width]);

  const applyClientWindow = useCallback(() => {
    const root = rootGroupRef.current;
    if (!root || !hasVertexColors) {
      return;
    }
    applyClientAnatomyWindow(
      root,
      windowCenter,
      windowWidth,
      referenceWindowRef.current.center,
      referenceWindowRef.current.width
    );
  }, [hasVertexColors, windowCenter, windowWidth]);

  useEffect(() => {
    applyClientWindow();
  }, [applyClientWindow]);

  const syncSegmentVisibility = useCallback(() => {
    segmentNodesRef.current.forEach((node, itemId) => {
      const visible = segmentVisibilityRef.current.get(itemId);
      if (visible !== undefined) {
        setSegmentVisibility(node, visible);
      }
    });
  }, []);

  const applyVisualSettings = useCallback(() => {
    const preview = previewSceneRef.current;
    const root = rootGroupRef.current;
    if (!preview || !root) {
      return;
    }
    preview.applyOptions({ enhancedLighting, ssaoEnabled, exposure, preset });
    segmentColorsRef.current.forEach((color, node) => {
      applyTintScene(node, color, anatomyBlend, preset);
    });
    syncSegmentVisibility();
  }, [anatomyBlend, enhancedLighting, exposure, preset, ssaoEnabled, syncSegmentVisibility]);

  useEffect(() => {
    applyVisualSettings();
  }, [applyVisualSettings]);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    setError(null);
    setLegendItems([]);
    segmentNodesRef.current.clear();
    segmentColorsRef.current.clear();
    segmentVisibilityRef.current.clear();
    setHasVertexColors(false);
    setSceneMeshCount(0);

    let disposed = false;
    const mountNode = mountRef.current;
    const width = Math.max(mountNode.clientWidth, 320);
    const height = Math.max(mountNode.clientHeight, 280);

    const preview = createGlbPreviewScene(mountNode, width, height, {
      enhancedLighting,
      ssaoEnabled,
      exposure,
      preset,
    });
    previewSceneRef.current = preview;

    const { scene, camera, controls } = preview;

    if (!resolvedModels.length) {
      setError('No GLB models provided.');
      preview.dispose();
      return;
    }

    const rootGroup = new THREE.Group();
    rootGroupRef.current = rootGroup;
    scene.add(rootGroup);

    const loader = new GLTFLoader();
    const loadErrors: string[] = [];
    const nextLegend: LegendItem[] = [];
    let foundVertexColors = false;

    const loadAll = async () => {
      await Promise.all(
        resolvedModels.map(
          (model, index) =>
            new Promise<void>(resolve => {
              const paletteIndex =
                ((typeof model.segmentNumber === 'number' ? model.segmentNumber : index + 1) - 1) %
                COLOR_PALETTE.length;
              const color = COLOR_PALETTE[(paletteIndex + COLOR_PALETTE.length) % COLOR_PALETTE.length];
              const legendLabel = model.label || `Segment ${index + 1}`;
              const itemId = `${model.segmentNumber ?? index + 1}-${index}`;

              loader.load(
                model.url,
                gltf => {
                  if (disposed) {
                    resolve();
                    return;
                  }
                  const segmentRoot = cloneSegmentScene(gltf.scene);
                  prepareMeshGeometry(segmentRoot);
                  let modelHasVertexColors = false;
                  segmentRoot.traverse(node => {
                    const mesh = node as THREE.Mesh;
                    if (mesh.isMesh && mesh.geometry?.attributes?.color) {
                      modelHasVertexColors = true;
                    }
                  });
                  if (modelHasVertexColors) {
                    foundVertexColors = true;
                    storeBakedGrayscale(segmentRoot);
                  }
                  tintScene(segmentRoot, color, anatomyBlend, preset);
                  rootGroup.add(segmentRoot);
                  segmentNodesRef.current.set(itemId, segmentRoot);
                  segmentColorsRef.current.set(segmentRoot, color);
                  segmentVisibilityRef.current.set(itemId, true);
                  nextLegend.push({ id: itemId, color, label: legendLabel, visible: true });
                  resolve();
                },
                undefined,
                err => {
                  loadErrors.push(`${legendLabel}: ${err?.message || 'Failed to load'}`);
                  resolve();
                }
              );
            })
        )
      );

      if (disposed) {
        return;
      }

      if (foundVertexColors) {
        setHasVertexColors(true);
      }

      if (rootGroup.children.length !== nextLegend.length) {
        console.warn(
          `[GlbPreview] Legend/scene mismatch: ${nextLegend.length} legend entries, ${rootGroup.children.length} scene children`
        );
      }

      if (nextLegend.length) {
        setLegendItems(nextLegend);
      }
      setSceneMeshCount(rootGroup.children.length);

      if (rootGroup.children.length) {
        fitCameraToObject(camera, controls, rootGroup);
        applyVisualSettings();
        syncSegmentVisibility();
      } else {
        setError(loadErrors[0] || 'Failed to load GLB model');
      }

      if (loadErrors.length && rootGroup.children.length) {
        setError(`Some models failed: ${loadErrors.join(' | ')}`);
      }
    };

    loadAll();

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      preview.render();
    };
    animate();

    const onResize = () => {
      const w = Math.max(mountNode.clientWidth, 320);
      const h = Math.max(mountNode.clientHeight, 280);
      preview.resize(w, h);
    };
    onResize();
    window.addEventListener('resize', onResize);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    resizeObserver?.observe(mountNode);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
      preview.dispose();
      scene.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else if (mat) {
          mat.dispose();
        }
      });
      segmentNodesRef.current.clear();
      segmentColorsRef.current.clear();
      segmentVisibilityRef.current.clear();
      rootGroupRef.current = null;
      previewSceneRef.current = null;
      if (mountNode.contains(preview.renderer.domElement)) {
        mountNode.removeChild(preview.renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene bootstrap once per model set
  }, [resolvedModels]);

  const applyVisibilityToScene = useCallback(() => {
    segmentNodesRef.current.forEach((node, itemId) => {
      const visible = segmentVisibilityRef.current.get(itemId) ?? true;
      setSegmentVisibility(node, visible);
    });
  }, []);

  const setAllSegmentsVisible = useCallback((visible: boolean) => {
    segmentNodesRef.current.forEach((_node, itemId) => {
      segmentVisibilityRef.current.set(itemId, visible);
    });
    applyVisibilityToScene();
    setLegendItems(prev => prev.map(item => ({ ...item, visible })));
  }, [applyVisibilityToScene]);

  const toggleSegmentVisibility = (itemId: string) => {
    const currentVisible = segmentVisibilityRef.current.get(itemId) ?? true;
    const nextVisible = !currentVisible;

    segmentVisibilityRef.current.set(itemId, nextVisible);
    const node = segmentNodesRef.current.get(itemId);
    if (node) {
      setSegmentVisibility(node, nextVisible);
    }

    setLegendItems(prev =>
      prev.map(item => (item.id === itemId ? { ...item, visible: nextVisible } : item))
    );
  };

  const visibleLegendCount = legendItems.filter(item => item.visible).length;

  const renderControls = () => (
      <div className="border-input bg-black/20 flex flex-wrap items-start gap-3 rounded border px-3 py-2 text-xs text-gray-200">
        <label
          className="flex items-center gap-2"
          title="Scene lighting, shadows, and specular highlights (PBR + environment map). Does not change segment colors."
        >
          <input
            type="checkbox"
            checked={enhancedLighting}
            onChange={e => setEnhancedLighting(e.target.checked)}
          />
          <span>
            Enhanced lighting
            <span className="text-muted-foreground block text-[10px] font-normal">
              Overall scene brightness
            </span>
          </span>
        </label>
        <label
          className="flex items-center gap-2"
          title="Screen Space Ambient Occlusion — darkens creases for depth. Requires Enhanced lighting."
        >
          <input
            type="checkbox"
            checked={ssaoEnabled}
            disabled={!enhancedLighting}
            onChange={e => setSsaoEnabled(e.target.checked)}
          />
          <span>
            SSAO
            <span className="text-muted-foreground block text-[10px] font-normal">Crevice shadows</span>
          </span>
        </label>
        <label
          className="flex min-w-[140px] flex-col gap-1"
          title="Overall frame brightness after rendering (like camera exposure). Not the same as DICOM W/L."
        >
          <span>Exposure ({exposure.toFixed(2)})</span>
          <span className="text-muted-foreground text-[10px]">Whole image brighter/darker</span>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.05}
            value={exposure}
            onChange={e => setExposure(parseFloat(e.target.value))}
          />
        </label>
        {hasVertexColors && (
          <>
            <label
              className="flex min-w-[160px] flex-col gap-1"
              title="0% — segment legend color only. 100% — mostly CT intensity baked on the mesh."
            >
              <span>Anatomy blend ({Math.round(anatomyBlend * 100)}%)</span>
              <span className="text-muted-foreground text-[10px]">Segment color vs CT on surface</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={anatomyBlend}
                onChange={e => setAnatomyBlend(parseFloat(e.target.value))}
              />
            </label>
            <label
              className="flex min-w-[140px] flex-col gap-1"
              title="DICOM window center (HU). Affects baked CT layer only; little effect when Anatomy blend is low."
            >
              <span>Window center ({Math.round(windowCenter)})</span>
              <span className="text-muted-foreground text-[10px]">HU window center (CT)</span>
              <input
                type="range"
                min={-1000}
                max={1000}
                step={10}
                value={windowCenter}
                onChange={e => setWindowCenter(parseFloat(e.target.value))}
              />
            </label>
            <label
              className="flex min-w-[140px] flex-col gap-1"
              title="DICOM window width (HU). Narrower — more contrast; wider — more tissue visible on the surface."
            >
              <span>Window width ({Math.round(windowWidth)})</span>
              <span className="text-muted-foreground text-[10px]">HU window width (CT)</span>
              <input
                type="range"
                min={50}
                max={2000}
                step={10}
                value={windowWidth}
                onChange={e => setWindowWidth(parseFloat(e.target.value))}
              />
            </label>
          </>
        )}
        <label
          className="flex flex-col gap-1"
          title="Clinical — softer highlights. Presentation — brighter. Outline — subtle edge glow."
        >
          <span>Preset</span>
          <span className="text-muted-foreground text-[10px]">Lighting style</span>
          <select
            className="bg-background text-foreground rounded border px-2 py-1 text-xs"
            value={preset}
            onChange={e => setPreset(e.target.value as PreviewPreset)}
          >
            <option value="clinical">Clinical</option>
            <option value="presentation">Presentation</option>
            <option value="outline">Outline</option>
          </select>
        </label>
        {onRegenerate && (
          <button
            type="button"
            className="border-white/20 rounded border px-2 py-1 hover:bg-white/10 disabled:opacity-50"
            disabled={isRegenerating}
            onClick={onRegenerate}
          >
            {isRegenerating ? 'Regenerating…' : 'Regenerate preview'}
          </button>
        )}
      </div>
  );

  const renderSegmentSidebar = () => (
    <aside className="border-input flex h-full max-h-full min-h-0 w-56 shrink-0 flex-col rounded border bg-black/20 md:w-60">
      <div className="border-b border-white/10 px-3 py-2">
        <div
          className="text-xs font-medium text-gray-100"
          title="Controls only this GLB preview dialog, not the OHIF segmentation panel behind it."
        >
          GLB segments
        </div>
        <div className="text-muted-foreground mt-1 text-[10px]">
          {visibleLegendCount} / {legendItems.length} visible
          {sceneMeshCount !== legendItems.length && legendItems.length > 0 && (
            <span className="text-amber-400"> · scene: {sceneMeshCount}</span>
          )}
        </div>
        {legendItems.length > 0 && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="flex-1 rounded border border-white/25 bg-white/10 px-2 py-1 text-[11px] font-medium text-gray-100 hover:bg-white/20"
              onClick={() => setAllSegmentsVisible(true)}
            >
              Show all
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-white/25 bg-white/10 px-2 py-1 text-[11px] font-medium text-gray-100 hover:bg-white/20"
              onClick={() => setAllSegmentsVisible(false)}
            >
              Hide all
            </button>
          </div>
        )}
      </div>
      {legendItems.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <ul className="flex flex-col gap-1.5">
            {legendItems.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => toggleSegmentVisibility(item.id)}
                  className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition ${
                    item.visible
                      ? 'border-white/20 bg-white/10 text-gray-100'
                      : 'border-white/10 bg-black/20 text-gray-400 opacity-70'
                  }`}
                  title={item.visible ? 'Hide this segment in GLB' : 'Show this segment in GLB'}
                >
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-full border border-white/30"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="text-muted-foreground p-3 text-xs">No segments loaded.</div>
      )}
    </aside>
  );

  return (
    <div
      className="flex flex-col gap-3"
      // Near-full-height by default; the bottom-right corner is a native CSS
      // resize handle. The three.js canvas follows via its ResizeObserver.
      style={{
        width: '88vw',
        height: 'calc(92vh - 6rem)',
        minWidth: 640,
        minHeight: 420,
        maxWidth: '96vw',
        maxHeight: 'calc(96vh - 5rem)',
        resize: 'both',
        overflow: 'hidden',
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="text-foreground text-base font-medium">{title || '3D Preview (GLB)'}</div>
        <button
          type="button"
          className="bg-primary text-primary-foreground shrink-0 rounded px-3 py-1 text-sm"
          onClick={() => hide?.()}
        >
          Close
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {resolvedModels.length > 0 &&
          (legendItems.length > 0 ? (
            renderSegmentSidebar()
          ) : (
            <aside className="border-input flex h-full w-56 shrink-0 flex-col rounded border bg-black/20 p-3 text-xs text-gray-400 md:w-60">
              Loading segments…
            </aside>
          ))}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {renderControls()}

          <div className="border-input relative min-h-0 flex-1 overflow-hidden rounded border bg-[#0d1b2a]">
            <div ref={mountRef} className="absolute inset-0" />
            {error && (
              <div className="absolute inset-x-0 top-0 z-10 bg-red-900/85 px-3 py-2 text-sm text-white">
                {error}
              </div>
            )}
          </div>

          <div className="text-muted-foreground shrink-0 text-xs">
            Mouse: rotate | Shift + drag: pan | Wheel: zoom | Drag bottom-right corner to resize
            {hasVertexColors ? ' · Anatomy blend uses CT intensity baked into the mesh.' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
