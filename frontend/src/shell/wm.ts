/**
 * Window manager state. Home is index -1; workspaces hold at most two windows.
 * Persisted per device (localStorage), so the layout survives reloads.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useEmber } from "../ember/store";
import { APPS, DEFAULT_PINNED, MAX_PINNED } from "./apps";

export const MAX_PER_WORKSPACE = 2;
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.8;

export interface Win {
  id: string;
  appId: string;
}

/** Floating rect as fractions of the workspace content area. */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Workspace {
  id: string;
  windows: string[];
  layout: "tiled" | "floating";
  split: "row" | "col";
  ratio: number;
  float: Record<string, FloatRect>;
  focused: string | null;
}

interface WMState {
  windows: Record<string, Win>;
  workspaces: Workspace[];
  current: number; // -1 = Home
  pinned: string[];
  taskView: boolean;
  spotlight: boolean;
}

interface WMActions {
  /** `window`: open a sidebar app (Ember) as a normal window instead. */
  openApp: (appId: string, opts?: { newWorkspace?: boolean; window?: boolean }) => void;
  closeWindow: (winId: string) => void;
  focusWindow: (winId: string) => void;
  goTo: (index: number) => void;
  step: (delta: number) => void;
  addWorkspace: () => void;
  moveWindow: (winId: string, toWorkspace: number | "new") => boolean;
  reorderWorkspaces: (ids: string[]) => void;
  setLayout: (wsId: string, layout: Workspace["layout"]) => void;
  toggleSplit: (wsId: string) => void;
  swapWindows: (wsId: string) => void;
  setRatio: (wsId: string, ratio: number) => void;
  setFloat: (wsId: string, winId: string, rect: FloatRect) => void;
  snapToTile: (wsId: string, winId: string, side: "start" | "end") => void;
  setPinned: (ids: string[]) => void;
  togglePin: (appId: string) => boolean;
  setTaskView: (open: boolean) => void;
  setSpotlight: (open: boolean) => void;
  ask: (q: string) => void;
}

export type WM = WMState & WMActions;

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

function newWorkspace(windows: string[] = []): Workspace {
  return {
    id: uid(),
    windows,
    layout: "tiled",
    split: "row",
    ratio: 0.5,
    float: {},
    focused: windows[0] ?? null,
  };
}

export function defaultFloat(i: number): FloatRect {
  return { x: 0.08 + i * 0.06, y: 0.06 + i * 0.06, w: 0.56, h: 0.72 };
}

/** Drop empty workspaces except the current one; keep `current` pointing at the same workspace. */
function prune(state: Pick<WMState, "workspaces" | "current">): Pick<WMState, "workspaces" | "current"> {
  const cur = state.workspaces[state.current];
  const workspaces = state.workspaces.filter((w) => w.windows.length > 0 || w === cur);
  const current = cur ? workspaces.indexOf(cur) : -1;
  return { workspaces, current };
}

function omit<T>(o: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}

function mapWs(list: Workspace[], id: string, fn: (w: Workspace) => Workspace): Workspace[] {
  return list.map((w) => (w.id === id ? fn(w) : w));
}

export const useWM = create<WM>()(
  persist(
    (set, get) => ({
      windows: {},
      workspaces: [],
      current: -1,
      pinned: DEFAULT_PINNED,
      taskView: false,
      spotlight: false,

      openApp: (appId, opts = {}) => {
        const app = APPS[appId];
        if (!app) return;
        if (app.sidebar && !opts.window) {
          useEmber.getState().setOpen(true); // focuses Ember's window instead when one is open
          set({ taskView: false, spotlight: false });
          return;
        }
        const s = get();
        if (!app.multiInstance && !opts.newWorkspace) {
          const existing = Object.values(s.windows).find((w) => w.appId === appId);
          if (existing) {
            get().focusWindow(existing.id);
            return;
          }
        }
        const win: Win = { id: uid(), appId };
        const windows = { ...s.windows, [win.id]: win };
        const cur = s.workspaces[s.current];
        const canPair = app.pairable && cur && cur.windows.length === 1 && !opts.newWorkspace;
        const intoEmpty = cur && cur.windows.length === 0;
        let workspaces: Workspace[];
        let current: number;
        if (cur && (canPair || intoEmpty)) {
          workspaces = mapWs(s.workspaces, cur.id, (w) => ({
            ...w,
            windows: [...w.windows, win.id],
            float: { ...w.float, [win.id]: defaultFloat(w.windows.length) },
            focused: win.id,
          }));
          current = s.current;
        } else {
          const ws = newWorkspace([win.id]);
          ws.float[win.id] = defaultFloat(0);
          const at = s.current + 1;
          workspaces = [...s.workspaces.slice(0, at), ws, ...s.workspaces.slice(at)];
          current = at;
        }
        set({ windows, ...prune({ workspaces, current }), taskView: false, spotlight: false });
      },

      closeWindow: (winId) => {
        const s = get();
        const windows = omit(s.windows, winId);
        const idx = s.workspaces.findIndex((w) => w.windows.includes(winId));
        if (idx < 0) return set({ windows });
        let workspaces = s.workspaces.map((w, i) => {
          if (i !== idx) return w;
          const rest = w.windows.filter((id) => id !== winId);
          return {
            ...w,
            windows: rest,
            float: omit(w.float, winId),
            focused: rest[0] ?? null,
            layout: rest.length ? w.layout : "tiled",
          };
        }) as Workspace[];
        let current = s.current;
        if (workspaces[idx]!.windows.length === 0) {
          workspaces = workspaces.filter((_, i) => i !== idx);
          if (current === idx) current = Math.min(idx, workspaces.length - 1);
          else if (current > idx) current--;
          if (workspaces.length === 0) current = -1;
        }
        set({ windows, workspaces, current });
      },

      focusWindow: (winId) => {
        const s = get();
        const idx = s.workspaces.findIndex((w) => w.windows.includes(winId));
        if (idx < 0) return;
        const workspaces = s.workspaces.map((w, i) => (i === idx ? { ...w, focused: winId } : w));
        set({ ...prune({ workspaces, current: idx }), taskView: false });
      },

      goTo: (index) => {
        const s = get();
        const clamped = Math.max(-1, Math.min(index, s.workspaces.length - 1));
        set(prune({ workspaces: s.workspaces, current: clamped }));
      },

      step: (delta) => get().goTo(get().current + delta),

      addWorkspace: () => {
        const s = get();
        const workspaces = [...s.workspaces.filter((w) => w.windows.length > 0), newWorkspace()];
        set({ workspaces, current: workspaces.length - 1 });
      },

      moveWindow: (winId, to) => {
        const s = get();
        const from = s.workspaces.findIndex((w) => w.windows.includes(winId));
        if (from < 0) return false;
        let workspaces = s.workspaces;
        let target: number;
        if (to === "new") {
          workspaces = [...workspaces, newWorkspace()];
          target = workspaces.length - 1;
        } else {
          target = to;
        }
        if (target === from) return true;
        const dest = workspaces[target];
        if (!dest || dest.windows.length >= MAX_PER_WORKSPACE) return false;
        const src = workspaces[from]!;
        const rect = src.float[winId] ?? defaultFloat(dest.windows.length);
        workspaces = workspaces.map((w, i) => {
          if (i === from) {
            const rest = w.windows.filter((id) => id !== winId);
            return { ...w, windows: rest, float: omit(w.float, winId), focused: rest[0] ?? null };
          }
          if (i === target)
            return {
              ...w,
              windows: [...w.windows, winId],
              float: { ...w.float, [winId]: rect },
              focused: winId,
            };
          return w;
        });
        const curId = s.workspaces[s.current]?.id;
        workspaces = workspaces.filter((w) => w.windows.length > 0);
        const current = curId ? workspaces.findIndex((w) => w.id === curId) : -1;
        set({
          workspaces,
          current: current >= 0 ? current : Math.min(Math.max(s.current, -1), workspaces.length - 1),
        });
        return true;
      },

      reorderWorkspaces: (ids) => {
        const s = get();
        const byId = new Map(s.workspaces.map((w) => [w.id, w]));
        const workspaces = ids.map((id) => byId.get(id)).filter((w): w is Workspace => !!w);
        if (workspaces.length !== s.workspaces.length) return;
        const curId = s.workspaces[s.current]?.id;
        set({ workspaces, current: curId ? workspaces.findIndex((w) => w.id === curId) : -1 });
      },

      setLayout: (wsId, layout) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => {
            const float = { ...w.float };
            w.windows.forEach((id, i) => (float[id] ??= defaultFloat(i)));
            return { ...w, layout, float };
          }),
        })),
      toggleSplit: (wsId) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => ({ ...w, split: w.split === "row" ? "col" : "row" })),
        })),
      swapWindows: (wsId) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => ({ ...w, windows: [...w.windows].reverse() })),
        })),
      setRatio: (wsId, ratio) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => ({
            ...w,
            ratio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)),
          })),
        })),
      setFloat: (wsId, winId, rect) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => ({ ...w, float: { ...w.float, [winId]: rect } })),
        })),
      snapToTile: (wsId, winId, side) =>
        set((s) => ({
          workspaces: mapWs(s.workspaces, wsId, (w) => {
            const others = w.windows.filter((id) => id !== winId);
            return {
              ...w,
              layout: "tiled",
              split: "row",
              windows: side === "start" ? [winId, ...others] : [...others, winId],
              focused: winId,
            };
          }),
        })),

      setPinned: (ids) => set({ pinned: ids.filter((id) => APPS[id]).slice(0, MAX_PINNED) }),
      togglePin: (appId) => {
        const { pinned } = get();
        if (pinned.includes(appId)) {
          set({ pinned: pinned.filter((p) => p !== appId) });
          return true;
        }
        if (pinned.length >= MAX_PINNED) return false;
        set({ pinned: [...pinned, appId] });
        return true;
      },
      setTaskView: (open) => set({ taskView: open, spotlight: false }),
      setSpotlight: (open) => set({ spotlight: open, taskView: open ? false : get().taskView }),
      ask: (q) => {
        set({ taskView: false, spotlight: false });
        useEmber.getState().ask(q);
      },
    }),
    {
      name: "kiln.wm.v1",
      storage: createJSONStorage(() => {
        try {
          localStorage.setItem("kiln.probe", "1");
          localStorage.removeItem("kiln.probe");
          return localStorage;
        } catch {
          const mem = new Map<string, string>();
          return {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => void mem.set(k, v),
            removeItem: (k: string) => void mem.delete(k),
          };
        }
      }),
      partialize: (s) => ({
        windows: s.windows,
        workspaces: s.workspaces,
        current: s.current,
        pinned: s.pinned,
      }),
      // Drop anything that no longer makes sense (unknown apps, dangling ids, overfull workspaces).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WMState>;
        const windows: Record<string, Win> = {};
        for (const [id, w] of Object.entries(p.windows ?? {}))
          if (w && APPS[w.appId]) windows[id] = { id, appId: w.appId };
        const workspaces = (p.workspaces ?? [])
          .map((w) => ({
            ...newWorkspace(),
            ...w,
            windows: (w.windows ?? []).filter((id) => windows[id]).slice(0, MAX_PER_WORKSPACE),
            float: w.float ?? {},
          }))
          .filter((w) => w.windows.length > 0);
        const placed = new Set(workspaces.flatMap((w) => w.windows));
        for (const id of Object.keys(windows)) if (!placed.has(id)) Reflect.deleteProperty(windows, id);
        const cur = typeof p.current === "number" ? Math.min(p.current, workspaces.length - 1) : -1;
        const pinned = (p.pinned ?? DEFAULT_PINNED).filter((id) => APPS[id]).slice(0, MAX_PINNED);
        return { ...current, windows, workspaces, current: cur, pinned };
      },
    },
  ),
);

export function workspaceOf(winId: string): number {
  return useWM.getState().workspaces.findIndex((w) => w.windows.includes(winId));
}
