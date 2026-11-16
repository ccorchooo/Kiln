import type { FloatRect } from "./wm";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GAP = 12;
export const MIN_W = 300;
export const MIN_H = 200;

/** Workspace content area: comfortable margins, clear of the floating taskbar. */
export function contentArea(vw: number, vh: number, mobile: boolean): Box {
  const m = mobile ? 8 : 16;
  const bottom = mobile ? 80 : 84;
  return { x: m, y: m, w: Math.max(0, vw - 2 * m), h: Math.max(0, vh - m - bottom) };
}

export function tiledBoxes(area: Box, count: number, split: "row" | "col", ratio: number): Box[] {
  if (count <= 1) return [area];
  if (split === "row") {
    const avail = area.w - GAP;
    const a = Math.round(avail * ratio);
    return [
      { x: area.x, y: area.y, w: a, h: area.h },
      { x: area.x + a + GAP, y: area.y, w: avail - a, h: area.h },
    ];
  }
  const avail = area.h - GAP;
  const a = Math.round(avail * ratio);
  return [
    { x: area.x, y: area.y, w: area.w, h: a },
    { x: area.x, y: area.y + a + GAP, w: area.w, h: avail - a },
  ];
}

export function floatBox(area: Box, r: FloatRect): Box {
  const w = Math.max(MIN_W, r.w * area.w);
  const h = Math.max(MIN_H, r.h * area.h);
  return {
    x: area.x + Math.min(Math.max(0, r.x * area.w), Math.max(0, area.w - 80)),
    y: area.y + Math.min(Math.max(0, r.y * area.h), Math.max(0, area.h - 48)),
    w: Math.min(w, area.w),
    h: Math.min(h, area.h),
  };
}

export function toFloatRect(area: Box, b: Box): FloatRect {
  return { x: (b.x - area.x) / area.w, y: (b.y - area.y) / area.h, w: b.w / area.w, h: b.h / area.h };
}

/** Rubber-band a value past [min, max] (elastic resistance at the limits). */
export function rubber(v: number, min: number, max: number, k = 0.25): number {
  if (v < min) return min - (min - v) * k;
  if (v > max) return max + (v - max) * k;
  return v;
}
