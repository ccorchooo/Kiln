/** Widget config (server-stored, shared across devices) and metric payload shapes. */

export type WidgetType =
  | "ai"
  | "cpu"
  | "gpu"
  | "memory"
  | "temps"
  | "disk"
  | "network"
  | "clock"
  | "weather"
  | "media"
  | "updates"
  | "notifications"
  | "battery"
  | "uptime";

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  size: "compact" | "expanded";
  lock: boolean;
  options: Record<string, unknown>;
}

export const MAX_WIDGETS = 8;

/** Server topic per widget type (clock and notifications are client-side). */
export function topicOf(type: WidgetType): string | null {
  return type === "clock" || type === "notifications" ? null : type;
}

export interface CpuData {
  usage: number;
  per_core: number[];
  freq_mhz: number | null;
  temp_c: number | null;
}
export interface MemoryData {
  used: number;
  total: number;
  percent: number;
  swap_used: number;
  swap_total: number;
  swap_percent: number;
}
export interface GpuData {
  available: boolean;
  vendor: string | null;
  name: string | null;
  usage: number | null;
  temp_c: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  power_w: number | null;
  install?: string;
}
export interface TempsData {
  sensors: { label: string; current: number }[];
  hottest: { label: string; current: number } | null;
}
export interface DiskData {
  mounts: { mount: string; used: number; total: number; percent: number }[];
  read_bps: number | null;
  write_bps: number | null;
}
export interface NetworkData {
  up_bps: number | null;
  down_bps: number | null;
  tailscale: {
    installed: boolean;
    running: boolean;
    ip?: string | null;
    online_peers: number | null;
    exit_node?: string | null;
    install?: string;
  };
}
export interface BatteryData {
  present: boolean;
  percent: number | null;
  plugged: boolean | null;
  secs_left: number | null;
}
export interface UptimeData {
  uptime_s: number;
  load: [number, number, number];
}
export interface UpdatesData {
  available: boolean;
  repo: number | null;
  aur: number | null;
  checked_at: number | null;
  checking: boolean;
  install?: string;
}
export interface WeatherData {
  available: boolean;
  city?: string;
  temp_c?: number | null;
  code?: number | null;
  description?: string | null;
  is_day?: boolean | number | null;
  wind_kmh?: number | null;
  high?: number | null;
  low?: number | null;
  sunrise?: string | null;
  sunset?: string | null;
  forecast?: { date: string; code: number; description: string; max: number; min: number }[];
  error?: string;
}
export interface MediaData {
  available: boolean;
  install?: string;
  playing?: {
    player: string | null;
    status: string | null;
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    length: number | null;
    position: number | null;
    volume: number | null;
  } | null;
}
export interface AiData {
  model: string;
  reachable: boolean;
}

export interface MetricsData {
  cpu?: CpuData;
  memory?: MemoryData;
  gpu?: GpuData;
  temps?: TempsData;
  disk?: DiskData;
  network?: NetworkData;
  battery?: BatteryData;
  uptime?: UptimeData;
  updates?: UpdatesData;
  weather?: WeatherData;
  media?: MediaData;
  ai?: AiData;
}
