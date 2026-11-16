/**
 * Theme tokens. A theme defines a light and a dark palette; applyTheme() writes them as CSS
 * variables on <html>, and the WebGL scenes read the same objects for their uniforms.
 *
 * Accent and status hues are used for fills, icons and the orb (≥3:1 non-text contrast).
 * Text in those colors uses the *Ink variants, which meet WCAG AA (4.5:1) on bg and surface.
 */

export type Mode = "light" | "dark";

export interface Palette {
  bg: string;
  surface: string; // glass tint (hex)
  surfaceAlpha: number;
  text: string;
  text2: string;
  hairline: string; // hex, applied at hairlineAlpha
  hairlineAlpha: number;
  accent: string;
  accentInk: string; // accent-colored text
  accentFill: string; // filled buttons
  onAccent: string; // text on accentFill
  accentSoft: string;
  success: string;
  successInk: string;
  warn: string;
  warnInk: string;
  danger: string;
  dangerInk: string;
  shadow: string; // warm shadow color
  wallpaper: [string, string, string, string, string];
  orb: [string, string, string]; // deep → mid → light
  orbRim: string;
  grain: number;
}

export interface Theme {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

export const clay: Theme = {
  id: "clay",
  name: "Clay",
  light: {
    bg: "#F5F0E8",
    surface: "#FAF8F3",
    surfaceAlpha: 0.65,
    text: "#1F1D1A",
    text2: "#6B645B",
    hairline: "#1F1D1A",
    hairlineAlpha: 0.1,
    accent: "#C96442",
    accentInk: "#9E4F34",
    accentFill: "#B35A3B",
    onAccent: "#FFFFFF",
    accentSoft: "#F0D9CC",
    success: "#6E8B5E",
    successInk: "#4A6340",
    warn: "#C89B3C",
    warnInk: "#7D5F1E",
    danger: "#B5533C",
    dangerInk: "#963F2C",
    shadow: "#5A3A28",
    wallpaper: ["#F5F0E8", "#F2D3BC", "#DE9B7B", "#E7DCC9", "#E3C2BC"],
    orb: ["#C96442", "#EDAE8A", "#FBF1E4"],
    orbRim: "#FFF6EC",
    grain: 0.035,
  },
  dark: {
    bg: "#1C1916",
    surface: "#2A2622",
    surfaceAlpha: 0.6,
    text: "#EEE7DC",
    text2: "#A89E91",
    hairline: "#EEE7DC",
    hairlineAlpha: 0.1,
    accent: "#D97757",
    accentInk: "#E59478",
    accentFill: "#D97757",
    onAccent: "#1C1916",
    accentSoft: "#4A3127",
    success: "#8AA77A",
    successInk: "#9DB88E",
    warn: "#D6AE55",
    warnInk: "#DDB866",
    danger: "#CF6F57",
    dangerInk: "#E08A72",
    shadow: "#000000",
    wallpaper: ["#1C1916", "#4A2A1E", "#7A3E28", "#3A2A2C", "#2B241F"],
    orb: ["#A8442A", "#E0875F", "#F6C9A0"],
    orbRim: "#FFD9B8",
    grain: 0.04,
  },
};

export const THEMES: Record<string, Theme> = { clay };

export function getTheme(id: string): Theme {
  return THEMES[id] ?? clay;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
}

export function luminance(hex: string): number {
  const c = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Blend a translucent surface over the bg to get the effective color text sits on. */
function over(top: string, alpha: number, bottom: string): string {
  const t = hexToRgb(top);
  const b = hexToRgb(bottom);
  const m = t.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)));
  return "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export interface ContrastIssue {
  pair: string;
  ratio: number;
  required: number;
}

/** WCAG AA check for every text/background pair the UI uses. */
export function checkPalette(p: Palette): ContrastIssue[] {
  const glass = over(p.surface, p.surfaceAlpha, p.bg);
  const pairs: [string, string, string, number][] = [
    ["text on bg", p.text, p.bg, 4.5],
    ["text on glass", p.text, glass, 4.5],
    ["secondary on bg", p.text2, p.bg, 4.5],
    ["secondary on glass", p.text2, glass, 4.5],
    ["accent text on bg", p.accentInk, p.bg, 4.5],
    ["accent text on glass", p.accentInk, glass, 4.5],
    ["button label", p.onAccent, p.accentFill, 4.5],
    ["success text", p.successInk, glass, 4.5],
    ["warning text", p.warnInk, glass, 4.5],
    ["danger text", p.dangerInk, glass, 4.5],
    ["accent (non-text) on bg", p.accent, p.bg, 3],
    ["focus ring on glass", p.accent, glass, 3],
  ];
  return pairs
    .map(([pair, fg, bg, required]) => ({ pair, ratio: contrast(fg, bg), required }))
    .filter((r) => r.ratio < r.required);
}

/** Write palette tokens as CSS variables. */
export function applyPalette(p: Palette, mode: Mode): void {
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--bg": p.bg,
    "--surface": rgba(p.surface, p.surfaceAlpha),
    "--surface-solid": over(p.surface, 0.94, p.bg),
    "--surface-strong": rgba(p.surface, Math.min(0.92, p.surfaceAlpha + 0.2)),
    "--text": p.text,
    "--text-2": p.text2,
    "--hairline": rgba(p.hairline, p.hairlineAlpha),
    "--hairline-strong": rgba(p.hairline, p.hairlineAlpha * 1.8),
    "--accent": p.accent,
    "--accent-ink": p.accentInk,
    "--accent-fill": p.accentFill,
    "--on-accent": p.onAccent,
    "--accent-soft": p.accentSoft,
    "--success": p.success,
    "--success-ink": p.successInk,
    "--warn": p.warn,
    "--warn-ink": p.warnInk,
    "--danger": p.danger,
    "--danger-ink": p.dangerInk,
    "--shadow-color": rgba(p.shadow, mode === "light" ? 0.12 : 0.45),
    "--shadow-color-soft": rgba(p.shadow, mode === "light" ? 0.06 : 0.25),
    "--wp-0": p.wallpaper[0],
    "--wp-1": p.wallpaper[1],
    "--wp-2": p.wallpaper[2],
    "--wp-3": p.wallpaper[3],
    "--wp-4": p.wallpaper[4],
    "--orb-0": p.orb[0],
    "--orb-1": p.orb[1],
    "--orb-2": p.orb[2],
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.bg);
}
