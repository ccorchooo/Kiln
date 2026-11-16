import { create } from "zustand";
import { api } from "../lib/api";
import { toastError } from "../lib/toasts";
import { topicOf, type MetricsData, type WidgetConfig, type WidgetType } from "./types";

const HISTORY = 60;

interface WidgetStore {
  widgets: WidgetConfig[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (widgets: WidgetConfig[]) => Promise<void>;
}

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: "default-ai", type: "ai", size: "compact", lock: true, options: {} },
  { id: "default-clock", type: "clock", size: "compact", lock: true, options: {} },
];

export const useWidgets = create<WidgetStore>((set, get) => ({
  widgets: DEFAULT_WIDGETS,
  loaded: false,
  load: async () => {
    try {
      const r = await api<{ widgets: WidgetConfig[] }>("/api/settings/widgets");
      set({ widgets: r.widgets, loaded: true });
    } catch {
      set({ loaded: true }); // signed out or older server: keep defaults
    }
  },
  save: async (widgets) => {
    const prev = get().widgets;
    set({ widgets });
    try {
      const r = await api<{ widgets: WidgetConfig[] } | WidgetConfig[]>("/api/settings/widgets", {
        method: "PUT",
        body: { widgets },
      });
      set({ widgets: Array.isArray(r) ? r : r.widgets });
    } catch (err) {
      set({ widgets: prev });
      toastError("Couldn't save widgets", err);
    }
  },
}));

export function newWidget(type: WidgetType): WidgetConfig {
  const id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 12);
  return { id, type, size: "compact", lock: false, options: {} };
}

/** Numeric series kept client-side for expanded mini-charts. */
export type Series = "cpu" | "gpu" | "memory" | "temps" | "down" | "up" | "diskio";

interface MetricsStore {
  data: MetricsData;
  history: Record<Series, number[]>;
  connected: boolean;
  ingest: (patch: MetricsData) => void;
  setConnected: (c: boolean) => void;
}

function push(arr: number[], v: number | null | undefined): number[] {
  if (v === null || v === undefined || Number.isNaN(v)) return arr;
  const next = arr.length >= HISTORY ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

export const useMetrics = create<MetricsStore>((set) => ({
  data: {},
  history: { cpu: [], gpu: [], memory: [], temps: [], down: [], up: [], diskio: [] },
  connected: false,
  ingest: (patch) =>
    set((s) => {
      const h = { ...s.history };
      if (patch.cpu) h.cpu = push(h.cpu, patch.cpu.usage);
      if (patch.gpu) h.gpu = push(h.gpu, patch.gpu.usage);
      if (patch.memory) h.memory = push(h.memory, patch.memory.percent);
      if (patch.temps) h.temps = push(h.temps, patch.temps.hottest?.current);
      if (patch.network) {
        h.down = push(h.down, patch.network.down_bps);
        h.up = push(h.up, patch.network.up_bps);
      }
      if (patch.disk) h.diskio = push(h.diskio, (patch.disk.read_bps ?? 0) + (patch.disk.write_bps ?? 0));
      return { data: { ...s.data, ...patch }, history: h };
    }),
  setConnected: (connected) => set({ connected }),
}));

export function widgetTopics(widgets: WidgetConfig[]): string[] {
  return [...new Set(widgets.map((w) => topicOf(w.type)).filter((t): t is string => !!t))];
}

/** /ws/metrics client: subscribes to the topics the configured widgets need. */
export class MetricsSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private topics: string[] = [];

  start(topics: string[]): void {
    this.topics = topics;
    this.stopped = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  setTopics(topics: string[]): void {
    this.topics = topics;
    this.send({ type: "subscribe", topics });
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
    useMetrics.getState().setConnected(false);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onVisibility = () =>
    this.send({ type: "visibility", hidden: document.visibilityState === "hidden" });

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/metrics`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      useMetrics.getState().setConnected(true);
      this.send({ type: "subscribe", topics: this.topics });
      this.onVisibility();
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as { type?: string; data?: MetricsData };
        if (msg.type === "metrics" && msg.data) useMetrics.getState().ingest(msg.data);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      useMetrics.getState().setConnected(false);
      if (this.stopped || ev.code === 4401 || ev.code === 4403) return;
      const delay = Math.min(15000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }
}

export function reportWidgetError(err: unknown): void {
  toastError("Widget action failed", err);
}
