import { useCallback, useEffect } from "react";
import { api } from "../lib/api";
import { useUI, type Quality, type QualityPref } from "../lib/store";
import { applyPalette, getTheme, type Mode } from "./themes";

export interface Appearance {
  mode: Mode;
  preference: "auto" | "light" | "dark";
  next_switch: string | null;
  theme: string;
  quality: QualityPref;
}

let firstApply = true;

export function applyAppearance(a: Pick<Appearance, "mode" | "theme">): void {
  const theme = getTheme(a.theme);
  const root = document.documentElement;
  const ui = useUI.getState();
  const changed = ui.mode !== a.mode || ui.themeId !== theme.id;
  if (changed && !firstApply && !ui.reducedMotion) {
    root.classList.add("mode-transition");
    window.setTimeout(() => root.classList.remove("mode-transition"), 1100);
  }
  firstApply = false;
  applyPalette(theme[a.mode], a.mode);
  root.dataset.theme = theme.id;
  useUI.getState().set({ mode: a.mode, themeId: theme.id });
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export function resolveQuality(pref: QualityPref): Quality {
  if (!hasWebGL2()) return "off";
  if (pref !== "auto") return pref;
  const mobile = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
  return mobile ? "balanced" : "high";
}

/** Fetches appearance, follows sunrise/sunset switches, honours reduced motion. */
export function useAppearance(): (a: Appearance) => void {
  const accept = useCallback((a: Appearance) => {
    applyAppearance(a);
    useUI.getState().set({
      modePreference: a.preference,
      qualityPref: a.quality,
      quality: resolveQuality(a.quality),
    });
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const load = async () => {
      try {
        const a = await api<Appearance>("/api/public/appearance");
        accept(a);
        if (timer !== null) window.clearTimeout(timer);
        const until = a.next_switch ? new Date(a.next_switch).getTime() - Date.now() + 2000 : 15 * 60_000;
        timer = window.setTimeout(load, Math.max(5000, Math.min(until, 15 * 60_000)));
      } catch {
        timer = window.setTimeout(load, 30_000);
      }
    };
    void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);

    const rm = matchMedia("(prefers-reduced-motion: reduce)");
    const applyRm = () => useUI.getState().set({ reducedMotion: rm.matches });
    applyRm();
    rm.addEventListener("change", applyRm);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      rm.removeEventListener("change", applyRm);
    };
  }, [accept]);

  return accept;
}
