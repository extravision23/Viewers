import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
};

type LegendItem = {
  id: string;
  color: string;
  label: string;
  visible: boolean;
};

function fitCameraToObject(camera: THREE.PerspectiveCamera, controls: OrbitControls, object: THREE.Object3D) {
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
  controls.update();
}

export default function GlbPreviewDialog({ hide, modelUrl, models, title }: GlbPreviewDialogProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const segmentNodesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [legendItems, setLegendItems] = useState<LegendItem[]>([]);

  const resolvedModels: PreviewModel[] = useMemo(
    () => (Array.isArray(models) ? models : modelUrl ? [{ url: modelUrl }] : []).filter(m => !!m?.url),
    [models, modelUrl]
  );

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    setError(null);
    setLegendItems([]);
    segmentNodesRef.current.clear();

    let disposed = false;
    const mountNode = mountRef.current;
    const width = Math.max(mountNode.clientWidth, 320);
    const height = Math.max(mountNode.clientHeight, 280);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1b2a);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
    mountNode.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(2, 3, 1.5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x8db3ff, 0.6);
    fillLight.position.set(-2, -1, -2);
    scene.add(fillLight);

    if (!resolvedModels.length) {
      setError('No GLB models provided.');
      return;
    }

    const colorPalette = [
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

    const rootGroup = new THREE.Group();
    scene.add(rootGroup);
    const loader = new GLTFLoader();
    const loadErrors: string[] = [];
    const nextLegend: LegendItem[] = [];

    const tintScene = (obj: THREE.Object3D, colorHex: string) => {
      const color = new THREE.Color(colorHex);
      obj.traverse(node => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) {
          return;
        }
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(material => {
            const cloned = material.clone();
            const mat = cloned as THREE.MeshStandardMaterial;
            if ((mat as any).color) {
              mat.color = color.clone();
            }
            return cloned;
          });
        } else {
          const cloned = mesh.material.clone() as THREE.MeshStandardMaterial;
          if ((cloned as any).color) {
            cloned.color = color.clone();
          }
          mesh.material = cloned;
        }
      });
    };

    const loadAll = async () => {
      await Promise.all(
        resolvedModels.map(
          (model, index) =>
            new Promise<void>(resolve => {
              const paletteIndex =
                ((typeof model.segmentNumber === 'number' ? model.segmentNumber : index + 1) - 1) %
                colorPalette.length;
              const color = colorPalette[(paletteIndex + colorPalette.length) % colorPalette.length];
              const legendLabel = model.label || `Segment ${index + 1}`;
              const itemId = `${model.segmentNumber ?? index + 1}-${index}`;

              loader.load(
                model.url,
                gltf => {
                  if (disposed) {
                    resolve();
                    return;
                  }
                  tintScene(gltf.scene, color);
                  rootGroup.add(gltf.scene);
                  segmentNodesRef.current.set(itemId, gltf.scene);
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

      if (nextLegend.length) {
        setLegendItems(nextLegend);
      }

      if (rootGroup.children.length) {
        fitCameraToObject(camera, controls, rootGroup);
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
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = Math.max(mountNode.clientWidth, 320);
      const h = Math.max(mountNode.clientHeight, 280);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
      controls.dispose();
      renderer.dispose();
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
      mountNode.removeChild(renderer.domElement);
    };
  }, [resolvedModels]);

  const toggleSegmentVisibility = (itemId: string) => {
    const node = segmentNodesRef.current.get(itemId);
    if (!node) {
      return;
    }
    const nextVisible = !node.visible;
    node.visible = nextVisible;
    setLegendItems(prev =>
      prev.map(item => (item.id === itemId ? { ...item, visible: nextVisible } : item))
    );
  };

  return (
    <div className="flex w-[80vw] max-w-5xl flex-col gap-3">
      <div className="text-foreground text-base font-medium">{title || '3D Preview (GLB)'}</div>
      <div className="border-input bg-black/30 relative h-[65vh] min-h-[360px] overflow-hidden rounded border">
        <div ref={mountRef} className="h-full w-full" />
        {error && (
          <div className="absolute inset-x-0 top-0 bg-red-900/85 px-3 py-2 text-sm text-white">{error}</div>
        )}
      </div>
      <div className="text-muted-foreground text-xs">
        Mouse: rotate | Shift + drag: pan | Wheel: zoom
      </div>
      {legendItems.length > 0 && (
        <div className="grid grid-cols-2 gap-2 text-xs text-gray-200 md:grid-cols-3">
          {legendItems.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => toggleSegmentVisibility(item.id)}
              className={`flex items-center gap-2 rounded border px-2 py-1 text-left transition ${
                item.visible
                  ? 'border-white/20 bg-white/10 text-gray-100'
                  : 'border-white/10 bg-black/20 text-gray-400 opacity-70'
              }`}
              title={item.visible ? 'Click to hide segment' : 'Click to show segment'}
            >
              <span
                className="inline-block h-3 w-3 rounded-full border border-white/30"
                style={{ backgroundColor: item.color }}
              />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          className="bg-primary text-primary-foreground rounded px-3 py-1 text-sm"
          onClick={() => hide?.()}
        >
          Close
        </button>
      </div>
    </div>
  );
}
