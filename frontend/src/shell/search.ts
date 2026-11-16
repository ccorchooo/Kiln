/** Spotlight sources. Later phases add file, process and saved-command providers from the API. */
import type { LucideIcon } from "lucide-react";
import { Gauge, House, LayoutGrid, Lock, Monitor, Moon, Power, Sparkles, Sun, SunMoon } from "lucide-react";
import { api } from "../lib/api";
import { lockNow, panicNow } from "../lib/auth";
import { useAuth, useUI } from "../lib/store";
import { applyAppearance, resolveQuality, type Appearance } from "../theme/useAppearance";
import { openSettings } from "../apps/settings/section";
import { APP_ORDER, APPS } from "./apps";
import { useWM } from "./wm";

export interface Result {
  id: string;
  section: "Apps" | "Open" | "Settings" | "Actions";
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  keywords: string[];
  appId?: string;
  run: () => void;
  detail?: string;
}

/** Subsequence fuzzy score; 0 = no match. Rewards prefix, word starts and contiguous runs. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100 - t.length * 0.1;
  const idx = t.indexOf(q);
  if (idx >= 0) return 70 - idx * 0.5 + (t[idx - 1] === " " ? 10 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || t[found - 1] === " " ? 3 : 0);
    ti = found + 1;
  }
  return Math.min(60, score);
}

async function setAppearance(body: Partial<Pick<Appearance, "preference" | "quality">> & { mode?: string }) {
  const a = await api<Appearance>("/api/settings/appearance", { method: "PUT", body });
  applyAppearance(a);
  useUI
    .getState()
    .set({ modePreference: a.preference, qualityPref: a.quality, quality: resolveQuality(a.quality) });
}

function staticResults(): Result[] {
  const wm = useWM.getState();
  const apps: Result[] = APP_ORDER.map((id) => {
    const a = APPS[id]!;
    const cur = wm.workspaces[wm.current];
    const pairs = a.pairable && cur?.windows.length === 1;
    return {
      id: `app:${id}`,
      section: "Apps",
      title: a.name,
      subtitle: a.description,
      icon: a.icon,
      keywords: a.keywords,
      appId: id,
      detail: pairs
        ? "Opens next to the current app"
        : a.multiInstance
          ? "Opens on a new workspace"
          : "Opens or focuses its workspace",
      run: () => wm.openApp(id),
    };
  });
  const open: Result[] = wm.workspaces.flatMap((w, i) =>
    w.windows.map((winId) => {
      const a = APPS[wm.windows[winId]?.appId ?? ""]!;
      return {
        id: `win:${winId}`,
        section: "Open" as const,
        title: a.name,
        subtitle: `Workspace ${i + 1}`,
        icon: a.icon,
        keywords: [`workspace ${i + 1}`, "window", "open"],
        run: () => wm.focusWindow(winId),
      };
    }),
  );
  const settings: Result[] = [
    {
      id: "set:light",
      title: "Light mode",
      icon: Sun,
      keywords: ["theme", "appearance", "day"],
      run: () => void setAppearance({ mode: "light" }),
    },
    {
      id: "set:dark",
      title: "Dark mode",
      icon: Moon,
      keywords: ["theme", "appearance", "night"],
      run: () => void setAppearance({ mode: "dark" }),
    },
    {
      id: "set:auto",
      title: "Automatic light and dark",
      subtitle: "Follows sunrise and sunset",
      icon: SunMoon,
      keywords: ["theme", "appearance", "sunset", "sunrise"],
      run: () => void setAppearance({ mode: "auto" }),
    },
    {
      id: "set:appearance",
      title: "Appearance settings",
      icon: Monitor,
      keywords: ["graphics", "quality", "theme", "motion"],
      run: () => openSettings("appearance"),
    },
    {
      id: "set:dock",
      title: "Dock settings",
      subtitle: "Choose up to 5 pinned apps",
      icon: APPS.settings!.icon,
      keywords: ["pin", "taskbar", "apps"],
      run: () => openSettings("dock"),
    },
    {
      id: "set:widgets",
      title: "Taskbar widgets",
      subtitle: "Add, reorder and choose lock-screen widgets",
      icon: Monitor,
      keywords: ["widgets", "taskbar", "lock screen", "weather", "cpu", "gpu"],
      run: () => openSettings("taskbar"),
    },
    {
      id: "set:sessions",
      title: "Signed-in devices",
      icon: Gauge,
      keywords: ["sessions", "security", "revoke", "devices"],
      run: () => openSettings("sessions"),
    },
  ].map((r) => ({ ...r, section: "Settings" as const }));
  const actions: Result[] = [
    { id: "act:home", title: "Go home", icon: House, keywords: ["desktop", "orb"], run: () => wm.goTo(-1) },
    {
      id: "act:tasks",
      title: "Task view",
      icon: LayoutGrid,
      keywords: ["overview", "workspaces", "windows"],
      run: () => wm.setTaskView(true),
    },
    { id: "act:lock", title: "Lock", icon: Lock, keywords: ["screen", "away"], run: () => void lockNow() },
    {
      id: "act:panic",
      title: "Panic lock",
      subtitle: "End every session and kill terminals",
      icon: Power,
      keywords: ["kill", "emergency", "logout"],
      run: () => void panicNow(),
    },
  ].map((r) => ({ ...r, section: "Actions" as const }));
  return [...open, ...apps, ...settings, ...actions];
}

export function search(query: string): Result[] {
  const all = staticResults();
  if (!query.trim()) return all.filter((r) => r.section !== "Settings").slice(0, 12);
  return all
    .map((r) => ({
      r,
      s:
        Math.max(fuzzyScore(query, r.title), ...r.keywords.map((k) => fuzzyScore(query, k) * 0.8)) +
        (r.section === "Open" ? 5 : 0),
    }))
    .filter((x) => x.s > 8)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.r);
}

export function askResult(query: string): Result {
  const name = useAuth.getState().assistantName;
  return {
    id: "ask",
    section: "Actions",
    title: `Ask ${name}: “${query}”`,
    icon: Sparkles,
    keywords: [],
    run: () => useWM.getState().ask(query),
  };
}
