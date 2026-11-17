/**
 * One shared WebGL canvas for the wallpaper and the orb.
 *
 * Pipeline per frame (manual, useFrame priority 1):
 *   1. wallpaper → screen at full resolution (gradient, orb halo/shadow, dither, grain)
 *   2. orb (R3F scene, perspective camera) on top
 * With quality "low" step 1 is skipped and the canvas is transparent over the CSS wallpaper.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useUI, type OrbMood, type Quality } from "../lib/store";
import { getTheme, type Palette } from "../theme/themes";
import { readOrbAnchor } from "./OrbAnchor";
import { FULLSCREEN_VERT, ORB_FRAG, ORB_VERT, WALLPAPER_FRAG } from "./shaders";

const QUALITY: Record<Exclude<Quality, "off">, { dpr: number; detail: number; wallpaper: boolean }> = {
  high: { dpr: 1.5, detail: 64, wallpaper: true },
  balanced: { dpr: 1.25, detail: 40, wallpaper: true },
  low: { dpr: 1, detail: 24, wallpaper: false },
};

const MOOD_KEYS = ["listen", "think", "speak", "approval", "error"] as const;
type MoodKey = (typeof MOOD_KEYS)[number];
const MOOD_TARGET: Record<OrbMood, MoodKey | null> = {
  idle: null,
  listening: "listen",
  thinking: "think",
  speaking: "speak",
  approval: "approval",
  error: "error",
};

function vec3(hex: string): THREE.Vector3 {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function lerpHex(a: string, b: string, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(vec3(a)).lerp(vec3(b), t);
}

/** sRGB hex → OKLab (L, a, b). */
function oklab(hex: string): THREE.Vector3 {
  const lin = (c: THREE.Vector3) =>
    c.toArray().map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin(vec3(hex)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return new THREE.Vector3(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  );
}

/** Wallpaper colors as an OKLab ramp from the base (lightest in light mode, darkest in dark) to the accent. */
function wallpaperRamp(colors: string[], dark: boolean): THREE.Vector3[] {
  return colors.map(oklab).sort((a, b) => (dark ? a.x - b.x : b.x - a.x));
}

/** Gentle palette shift through the day (multiplier near 1). */
function timeOfDayTint(date = new Date()): THREE.Vector3 {
  const h = date.getHours() + date.getMinutes() / 60;
  const keys: [number, [number, number, number]][] = [
    [0, [0.97, 0.97, 1.0]],
    [6, [1.02, 0.995, 0.975]], // dawn: peachy
    [12, [1.0, 1.0, 1.0]],
    [18, [1.03, 0.985, 0.965]], // evening: rosier
    [21, [0.985, 0.975, 0.995]],
    [24, [0.97, 0.97, 1.0]],
  ];
  for (let i = 0; i < keys.length - 1; i++) {
    const [h0, c0] = keys[i]!;
    const [h1, c1] = keys[i + 1]!;
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return new THREE.Vector3(...c0.map((v, j) => v + (c1[j]! - v) * t));
    }
  }
  return new THREE.Vector3(1, 1, 1);
}

function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

interface Spring {
  x: number;
  v: number;
}
function stepSpring(s: Spring, target: number, dt: number, omega = 8, zeta = 0.92): void {
  const a = -2 * zeta * omega * s.v - omega * omega * (s.x - target);
  s.v += a * dt;
  s.x += s.v * dt;
}

function Pipeline({ quality }: { quality: Exclude<Quality, "off"> }) {
  const q = QUALITY[quality];
  const { gl, size, viewport, camera } = useThree();
  const orbRef = useRef<THREE.Mesh>(null);
  const fps = useRef({ acc: 0, n: 0, slow: 0 });
  const springs = useRef({ x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, s: { x: 0, v: 0 }, init: false });
  const weights = useRef<Record<MoodKey, number>>({ listen: 0, think: 0, speak: 0, approval: 0, error: 0 });
  const live = useRef({ dark: useUI.getState().mode === "dark" ? 1 : 0, level: 0, glow: 0, visible: 0 });
  const tint = useRef(timeOfDayTint());
  const palCache = useRef<{ id: string; light: THREE.Vector3[]; dark: THREE.Vector3[] } | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => (tint.current = timeOfDayTint()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const ortho = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
  const tri = useMemo(fullscreenTriangle, []);
  const wp = useMemo(() => {
    const u = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uDark: { value: 0 },
      uLight: { value: [] as THREE.Vector3[] },
      uDarkPal: { value: [] as THREE.Vector3[] },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uGrain: { value: 0.035 },
      uOrb: { value: new THREE.Vector2(0.5, 0.5) },
      uOrbR: { value: 0.1 },
      uGlow: { value: 0 },
      uOrbVisible: { value: 0 },
      uGlowColor: { value: new THREE.Vector3(1, 0.8, 0.6) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: WALLPAPER_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: u,
    });
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(tri, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { scene, mat, u };
  }, [tri]);
  const orb = useMemo(() => {
    const u = {
      uTime: { value: 0 },
      uMotion: { value: 1 },
      uListen: { value: 0 },
      uThink: { value: 0 },
      uSpeak: { value: 0 },
      uError: { value: 0 },
      uApproval: { value: 0 },
      uPulse: { value: 0 },
      uLevel: { value: 0 },
      uBands: { value: new THREE.Vector4() },
      uC0: { value: new THREE.Vector3() },
      uC1: { value: new THREE.Vector3() },
      uC2: { value: new THREE.Vector3() },
      uRim: { value: new THREE.Vector3() },
      uOchre: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      transparent: true,
      uniforms: u,
    });
    return { mat, u };
  }, []);
  const orbMat = orb.mat;
  const orbGeo = useMemo(() => new THREE.IcosahedronGeometry(1, q.detail), [q.detail]);

  useEffect(
    () => () => {
      tri.dispose();
      wp.mat.dispose();
      orbMat.dispose();
    },
    [tri, wp, orbMat],
  );
  useEffect(() => () => orbGeo.dispose(), [orbGeo]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const ui = useUI.getState();
    const theme = getTheme(ui.themeId);
    const L: Palette = theme.light;
    const D: Palette = theme.dark;
    const t = state.clock.elapsedTime;
    const motion = ui.reducedMotion ? 0 : 1;
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);

    // light/dark crossfade (~1s)
    const lv = live.current;
    lv.dark += ((ui.mode === "dark" ? 1 : 0) - lv.dark) * ease(4);

    // orb mood weights blend smoothly, never snap
    const target = MOOD_TARGET[ui.orbMood];
    for (const k of MOOD_KEYS) weights.current[k] += ((k === target ? 1 : 0) - weights.current[k]) * ease(3);
    const w = weights.current;
    lv.level += (ui.audio.level - lv.level) * ease(18);

    // position: spring toward the active DOM anchor
    const anchor = readOrbAnchor();
    const sp = springs.current;
    const k = viewport.height / size.height; // world units per CSS px at z = 0
    lv.visible += ((anchor ? 1 : 0) - lv.visible) * ease(5);
    if (anchor) {
      const tx = (anchor.cx - size.width / 2) * k;
      const ty = -(anchor.cy - size.height / 2) * k;
      const ts = (anchor.size / 2) * k * 0.86; // leave room for displacement
      if (!sp.init) {
        sp.x.x = tx;
        sp.y.x = ty;
        sp.s.x = ts;
        sp.init = true;
      }
      const omega = ui.reducedMotion ? 30 : 8;
      stepSpring(sp.x, tx, dt, omega);
      stepSpring(sp.y, ty, dt, omega);
      stepSpring(sp.s, ts, dt, omega);
    } else {
      stepSpring(sp.s, 0, dt, 8);
    }
    const breath = 1 + 0.03 * Math.sin((t * Math.PI * 2) / 4);
    const scale = Math.max(0.0001, sp.s.x * breath * (1 - 0.08 * w.error) * (1 + 0.04 * lv.level * w.speak));
    const mesh = orbRef.current;
    if (mesh) {
      mesh.position.set(sp.x.x, sp.y.x, 0);
      mesh.scale.setScalar(scale);
      mesh.visible = lv.visible > 0.01 && scale > 0.001;
    }

    // orb uniforms
    const u = orb.u;
    u.uTime.value = t;
    u.uMotion.value = motion;
    u.uListen.value = w.listen;
    u.uThink.value = w.think;
    u.uSpeak.value = w.speak;
    u.uError.value = w.error;
    u.uApproval.value = w.approval;
    const ph = t % 2.4;
    u.uPulse.value = Math.exp(-(((ph - 0.25) / 0.12) ** 2)) + Math.exp(-(((ph - 0.65) / 0.12) ** 2));
    u.uLevel.value = lv.level;
    const [b0, b1, b2, b3] = ui.audio.bands;
    u.uBands.value.set(b0, b1, b2, b3);
    lerpHex(L.orb[0], D.orb[0], lv.dark, u.uC0.value);
    lerpHex(L.orb[1], D.orb[1], lv.dark, u.uC1.value);
    lerpHex(L.orb[2], D.orb[2], lv.dark, u.uC2.value);
    lerpHex(L.orbRim, D.orbRim, lv.dark, u.uRim.value);
    lerpHex(L.warn, D.warn, lv.dark, u.uOchre.value);

    gl.autoClear = false;
    gl.setClearColor(0x000000, 0);
    if (q.wallpaper) {
      const wu = wp.u;
      wu.uTime.value = ui.reducedMotion ? 0 : t;
      wu.uRes.value.set(size.width, size.height);
      wu.uDark.value = lv.dark;
      if (palCache.current?.id !== theme.id) {
        palCache.current = {
          id: theme.id,
          light: wallpaperRamp(L.wallpaper, false),
          dark: wallpaperRamp(D.wallpaper, true),
        };
      }
      wu.uLight.value = palCache.current.light;
      wu.uDarkPal.value = palCache.current.dark;
      wu.uTint.value = tint.current;
      wu.uGrain.value = L.grain + (D.grain - L.grain) * lv.dark;
      if (anchor) {
        wu.uOrb.value.set(sp.x.x / k / size.width + 0.5, sp.y.x / k / size.height + 0.5);
        wu.uOrbR.value = sp.s.x / k / size.height;
      }
      wu.uOrbVisible.value = lv.visible;
      lv.glow += (w.speak * (0.4 + 0.6 * lv.level) - lv.glow) * ease(6);
      wu.uGlow.value = lv.glow;
      lerpHex(L.orb[1], D.orb[1], lv.dark, wu.uGlowColor.value);
      gl.clear();
      gl.render(wp.scene, ortho);
    } else {
      gl.clear();
    }
    gl.clearDepth();
    gl.render(state.scene, camera);

    // Auto quality: step down after sustained low frame rate.
    const f = fps.current;
    f.acc += rawDt;
    f.n++;
    if (f.acc >= 3) {
      const avg = f.n / f.acc;
      f.slow = avg < 40 ? f.slow + 1 : 0;
      f.acc = 0;
      f.n = 0;
      if (f.slow >= 2 && ui.qualityPref === "auto" && document.visibilityState === "visible") {
        const order: Quality[] = ["high", "balanced", "low"];
        const next = order[order.indexOf(ui.quality) + 1];
        if (next) ui.set({ quality: next });
        f.slow = 0;
      }
    }
  }, 1);

  return <mesh ref={orbRef} geometry={orbGeo} material={orbMat} frustumCulled={false} visible={false} />;
}

export function Scene() {
  const quality = useUI((s) => s.quality);
  const [hidden, setHidden] = useState(document.visibilityState === "hidden");
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  if (quality === "off") return null;
  const q = QUALITY[quality];
  return (
    <Canvas
      className="kiln-canvas"
      frameloop={hidden ? "never" : "always"}
      dpr={[1, Math.min(q.dpr, window.devicePixelRatio || 1)]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance", stencil: false }}
      flat
      linear
      camera={{ fov: 30, position: [0, 0, 10], near: 0.1, far: 100 }}
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}
      aria-hidden
    >
      <Pipeline quality={quality} />
    </Canvas>
  );
}
