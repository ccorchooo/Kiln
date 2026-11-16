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
 * Mesh-gradient wallpaper: five warm color fields drifting on looping paths (one cycle per
 * minute), domain-warped by low-frequency noise. Rendered at reduced resolution.
 */
export const WALLPAPER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;   // seconds (already scaled for reduced motion)
uniform float uAspect;
uniform float uDark;   // 0 = light palette, 1 = dark palette (animated crossfade)
uniform vec3 uLight[5];
uniform vec3 uDarkPal[5];
uniform vec3 uTint;    // gentle time-of-day shift (multiplier around 1.0)
${SIMPLEX3D}

void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  float t = uTime * 6.28318530718 / 60.0;
  vec2 warp = 0.16 * vec2(snoise(vec3(p * 1.1, t * 0.35)), snoise(vec3(p * 1.1 + 5.2, t * 0.35)));
  vec2 q = p + warp;

  vec2 c[5];
  float a = uAspect * 0.5;
  c[0] = vec2(-0.30 * a, 0.10) + vec2(0.20 * sin(t), 0.12 * cos(t * 2.0));
  c[1] = vec2(-0.55 * a, 0.32) + vec2(0.15 * cos(t), 0.10 * sin(t));
  c[2] = vec2( 0.50 * a, -0.30) + vec2(0.18 * sin(t * 2.0 + 1.3), 0.12 * cos(t + 0.4));
  c[3] = vec2( 0.62 * a, 0.36) + vec2(0.14 * cos(t + 2.1), 0.10 * sin(t * 2.0));
  c[4] = vec2(-0.40 * a, -0.42) + vec2(0.16 * sin(t + 4.0), 0.08 * cos(t));
  float r[5];
  r[0] = 0.70; r[1] = 0.42; r[2] = 0.46; r[3] = 0.40; r[4] = 0.44;

  vec3 col = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 d = q - c[i];
    float w = exp(-dot(d, d) / (r[i] * r[i]));
    vec3 ci = mix(uLight[i], uDarkPal[i], uDark);
    col += ci * w;
    wsum += w;
  }
  vec3 base = mix(uLight[0], uDarkPal[0], uDark);
  col = mix(base, col / max(wsum, 1e-4), clamp(wsum * 1.4, 0.0, 1.0));
  col *= uTint;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Upscale the low-res wallpaper, add the orb halo/contact shadow and full-res film grain. */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uGrain;
uniform vec2 uOrb;      // orb center in uv
uniform float uOrbR;    // orb radius in uv-y units
uniform float uGlow;    // 0..1, rises while speaking
uniform float uOrbVisible;
uniform vec3 uGlowColor;
uniform float uDark;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 col = texture2D(uTex, vUv).rgb;
  vec2 d = vUv - uOrb;
  d.x *= uRes.x / uRes.y;
  float r = length(d) / max(uOrbR, 1e-4);
  float halo = exp(-r * r * 0.35) * uOrbVisible;
  col += uGlowColor * halo * (0.06 + 0.22 * uGlow) * mix(1.0, 0.7, uDark);
  vec2 sd = (d - vec2(0.0, -uOrbR * 1.05)) * vec2(1.0, 2.6);
  float shadow = exp(-dot(sd, sd) / (uOrbR * uOrbR * 0.35)) * uOrbVisible;
  col *= 1.0 - shadow * mix(0.10, 0.25, uDark);
  float g = hash(floor(gl_FragCoord.xy) + floor(uTime * 12.0) * vec2(17.0, 31.0)) - 0.5;
  col += g * uGrain;
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
