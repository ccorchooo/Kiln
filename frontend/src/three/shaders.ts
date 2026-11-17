import { SIMPLEX3D } from "./noise";

/** Fullscreen triangle: positions are already in clip space. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Wallpaper, drawn at full resolution in one pass: a silky gradient that flows slowly between
 * the theme's wallpaper colors (blended in OKLab, so mid-tones stay clean instead of muddy),
 * the orb's halo and contact shadow, then a 1-LSB dither (no banding on dark palettes) and a
 * static film grain.
 */
export const WALLPAPER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;   // seconds (already scaled for reduced motion)
uniform float uDark;   // 0 = light palette, 1 = dark palette (animated crossfade)
uniform vec3 uLight[5];   // OKLab, ordered from the base color to the strongest accent
uniform vec3 uDarkPal[5];
uniform vec3 uTint;    // gentle time-of-day shift (multiplier around 1.0)
uniform float uGrain;
uniform vec2 uOrb;      // orb center in uv
uniform float uOrbR;    // orb radius in uv-y units
uniform float uGlow;    // 0..1, rises while speaking
uniform float uOrbVisible;
uniform vec3 uGlowColor;
${SIMPLEX3D}

vec3 ramp(float x) {
  x = clamp(x, 0.0, 1.0) * 4.0;
  vec3 col = mix(uLight[0], uDarkPal[0], uDark);
  for (int i = 0; i < 4; i++) {
    vec3 next = mix(uLight[i + 1], uDarkPal[i + 1], uDark);
    col = mix(col, next, smoothstep(float(i), float(i) + 1.0, x));
  }
  return col;
}

vec3 oklabToSrgb(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  vec3 lin = vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  lin = clamp(lin, 0.0, 1.0);
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}

// Stable per-pixel hash (no sin, no large multipliers: no patterns on mobile GPUs).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * 6.28318530718 / 90.0; // the sine drift loops every 90 s

  // Silk: a soft sine warp feeding one slow noise octave.
  vec2 w = 0.22 * vec2(sin(p.y * 2.3 + t), cos(p.x * 1.9 - t * 0.8));
  float n = snoise(vec3(p * 0.85 + w, uTime * 0.012));
  // Base color top-left, deepest accent pooling bottom-right.
  float diag = 0.5 + 0.5 * (p.x / aspect - p.y);
  vec3 lab = ramp(diag * 0.72 + n * 0.3 + 0.08);
  vec2 q = vUv * 2.0 - 1.0;
  lab.x *= 1.0 - 0.07 * uDark * dot(q, q); // quiet vignette, dark mode only (it greys cream)

  vec3 col = oklabToSrgb(lab) * uTint;

  vec2 d = vUv - uOrb;
  d.x *= aspect;
  float r = length(d) / max(uOrbR, 1e-4);
  float halo = exp(-r * r * 0.35) * uOrbVisible;
  col += uGlowColor * halo * (0.06 + 0.22 * uGlow) * mix(1.0, 0.7, uDark);
  vec2 sd = (d - vec2(0.0, -uOrbR * 1.05)) * vec2(1.0, 2.6);
  float shadow = exp(-dot(sd, sd) / (uOrbR * uOrbR * 0.35)) * uOrbVisible;
  col *= 1.0 - shadow * mix(0.10, 0.25, uDark);

  vec2 px = floor(gl_FragCoord.xy);
  col += (hash12(px) - hash12(px + 71.3)) / 255.0;   // triangular dither
  col += (hash12(px * 1.618 + 9.1) - 0.5) * uGrain; // grain, static so it never shimmers
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Liquid orb: icosphere displaced by layered simplex noise; normals by finite differences. */
export const ORB_VERT = /* glsl */ `
uniform float uTime;
uniform float uMotion;   // 1 normally, ~0 with reduced motion
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uError;
uniform float uLevel;    // mic or TTS amplitude 0..1
uniform vec4 uBands;     // low → high FFT bands 0..1
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vObj;
varying float vDisp;
${SIMPLEX3D}

float field(vec3 p) {
  float t = uTime * uMotion;
  float flow = 0.07 + 0.05 * uThink + 0.06 * uSpeak;
  // idle: broad, lazy liquid flow (low frequency, low amplitude: soft, never rocky)
  float n = snoise(p * 0.8 + vec3(0.0, t * flow, t * flow * 0.7)) * 0.085;
  n += snoise(p * 1.6 + vec3(t * 0.06, 0.0, -t * 0.04)) * 0.018;
  // thinking: slow inner swirl
  float ang = atan(p.z, p.x) + t * 0.6;
  n += sin(ang * 3.0 + p.y * 4.0) * 0.02 * uThink;
  // speaking: low bands = large slow wobble, high bands = fine surface detail
  n += snoise(p * 0.9 + t * 0.35) * 0.17 * uBands.x * uSpeak;
  n += snoise(p * 1.8 + t * 0.6) * 0.07 * uBands.y * uSpeak;
  n += snoise(p * 4.5 + t * 1.1) * 0.035 * (uBands.z + uBands.w) * uSpeak;
  // listening: ripples with mic level, leaning toward the viewer
  n += sin(p.y * 10.0 - t * 7.0) * 0.022 * uLevel * uListen;
  n += max(p.z, 0.0) * 0.08 * uLevel * uListen;
  return n * (1.0 - 0.6 * uError);
}

void main() {
  vec3 p = normalize(position);
  float d = field(p);
  vec3 pos = p * (1.0 + d);
  vec3 helper = abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(p, helper));
  vec3 bitangent = normalize(cross(p, tangent));
  float e = 0.012;
  vec3 p1 = normalize(p + tangent * e);
  vec3 p2 = normalize(p + bitangent * e);
  vec3 n = normalize(cross(p1 * (1.0 + field(p1)) - pos, p2 * (1.0 + field(p2)) - pos));
  if (dot(n, p) < 0.0) n = -n;
  vObj = p;
  vDisp = d;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const ORB_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uMotion;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uRim;
uniform vec3 uOchre;
uniform float uThink;
uniform float uApproval;
uniform float uPulse;
uniform float uError;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vObj;
varying float vDisp;
${SIMPLEX3D}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 2.4);
  float t = uTime * uMotion;

  // internal gradient: clay at the bottom-right, cream toward the top-left, slowly flowing
  float g = snoise(vObj * 0.95 + vec3(0.0, t * 0.05, t * 0.03)) * 0.5 + 0.5;
  float h = clamp(0.5 + 0.45 * vObj.y - 0.25 * vObj.x, 0.0, 1.0);
  float k = clamp(mix(h, g, 0.3) + vDisp * 0.9, 0.0, 1.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.7, k));
  col = mix(col, uC2, smoothstep(0.55, 1.05, k));

  // soft, wrapped light from the upper left + glossy highlight
  vec3 L = normalize(vec3(-0.5, 0.75, 0.75));
  float diff = dot(N, L) * 0.5 + 0.5;
  col *= mix(0.86, 1.06, diff);
  vec3 H = normalize(L + V);
  col += uRim * pow(max(dot(N, H), 0.0), 40.0) * 0.22;

  // thinking: a shimmering band drifting through
  float ang = atan(vObj.x, vObj.z);
  float band = smoothstep(0.7, 1.0, sin(ang * 2.0 + vObj.y * 3.0 - t * 1.4) * 0.5 + 0.5);
  col = mix(col, uC2, band * 0.35 * uThink);

  col = mix(col, uRim, fres * 0.5);
  col = mix(col, uOchre, uApproval * (0.42 + 0.22 * uPulse));
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * 0.92, uError * 0.75);

  float alpha = 1.0 - pow(1.0 - ndv, 7.0) * 0.55; // feathered silhouette: never a hard sphere
  gl_FragColor = vec4(col, alpha);
}
`;
