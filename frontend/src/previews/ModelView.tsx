import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { rawUrl } from "../apps/files/api";
import { toastError } from "../lib/toasts";
import type { PreviewProps } from "./index";
import { dirname, ErrorBox, Loading, resolveRelative } from "./common";

const FS_BASE = "/api/fs/";

function load(path: string): Promise<THREE.Object3D> {
  const dir = dirname(path);
  const manager = new THREE.LoadingManager();
  // Relative URIs inside .gltf/.fbx resolve against "/api/fs/"; route them through rawUrl.
  manager.setURLModifier((url) => {
    if (url.startsWith(FS_BASE) && !url.startsWith(`${FS_BASE}raw?`)) {
      const rel = decodeURIComponent(url.slice(FS_BASE.length).split(/[?#]/)[0]!);
      return rawUrl(resolveRelative(dir, rel));
    }
    return url;
  });
  const url = rawUrl(path);
  const ext = path.split(".").pop()!.toLowerCase();
  return new Promise((resolve, reject) => {
    if (ext === "obj") new OBJLoader(manager).load(url, resolve, undefined, reject);
    else if (ext === "fbx") new FBXLoader(manager).load(url, resolve, undefined, reject);
    else new GLTFLoader(manager).load(url, (g) => resolve(g.scene), undefined, reject);
  });
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    n += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count) / 3;
  });
  return Math.round(n);
}

function Model({ object, spin }: { object: THREE.Object3D; spin: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [object, invalidate]);
  // Keep the demand loop alive only while auto-rotating.
  useFrame(() => {
    if (spin) invalidate();
  });
  return <primitive object={object} />;
}

/** Normalise to a unit-ish size centred on the origin. */
function normalise(object: THREE.Object3D): THREE.Group {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 1.5 units keeps even a cube's diagonal inside the default camera's view with a margin.
  const k = 1.5 / (Math.max(size.x, size.y, size.z) || 1);
  const wrap = new THREE.Group();
  object.position.sub(center);
  const pivot = new THREE.Group();
  pivot.add(object);
  pivot.scale.setScalar(k);
  wrap.add(pivot);
  return wrap;
}

export default function ModelView({ entry, compact }: PreviewProps) {
  const [obj, setObj] = useState<THREE.Group | null>(null);
  const [tris, setTris] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let loaded: THREE.Object3D | null = null;
    setObj(null);
    setError(null);
    load(entry.path)
      .then((o) => {
        if (dead) return disposeTree(o);
        loaded = o;
        o.traverse((n) => {
          const m = n as THREE.Mesh;
          if (m.isMesh && !m.material) m.material = new THREE.MeshStandardMaterial({ color: "#d8c3ac" });
        });
        setTris(countTriangles(o));
        setObj(normalise(o));
      })
      .catch((e: unknown) => {
        if (dead) return;
        setError("Couldn't load this 3D model.");
        toastError("Couldn't load model", e);
      });
    return () => {
      dead = true;
      if (loaded) disposeTree(loaded);
    };
  }, [entry.path]);

  if (error) return <ErrorBox message={error} />;
  if (!obj) return <Loading label="Loading model…" />;
  return (
    <div className="relative h-full w-full">
      <Canvas frameloop="demand" camera={{ position: [2.6, 1.8, 3.2], fov: 40 }} dpr={[1, 1.5]}>
        {/* Offline three-point rig: warm key, cool-ish fill, rim. No environment maps. */}
        <hemisphereLight args={["#fff3e4", "#8a7a6a", 1.1]} />
        <directionalLight position={[4, 5, 3]} intensity={2.4} color="#ffe6cc" />
        <directionalLight position={[-4, 2, 2]} intensity={0.9} color="#dfe6f0" />
        <directionalLight position={[0, 3, -5]} intensity={1.2} color="#ffd9b8" />
        <Model object={obj} spin={!!compact} />
        <OrbitControls
          makeDefault
          enableDamping={false}
          autoRotate={!!compact}
          autoRotateSpeed={1.2}
          enablePan={!compact}
          enableZoom={!compact}
        />
      </Canvas>
      <span className="num pointer-events-none absolute bottom-2 left-3 rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent-ink">
        {tris.toLocaleString()} triangles
      </span>
    </div>
  );
}
