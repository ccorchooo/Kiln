/**
 * Taskbar / lock-screen widgets. Every widget is a frosted pill (compact: icon + value;
 * expanded: adds a mini-chart). Clicking opens a rounded popover that grows from the pill.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownUp,
  BatteryCharging,
  BatteryMedium,
  Bell,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cpu,
  Gpu,
  HardDrive,
  MemoryStick,
  Moon,
  Music2,
  Package,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EmberGlyph } from "../components/Brand";
import { spring } from "../components/motion";
import { api } from "../lib/api";
import { useAuth, useUI, type OrbMood } from "../lib/store";
import { useToasts } from "../lib/toasts";
import { useWM } from "../shell/wm";
import { OrbAnchor } from "../three/OrbAnchor";
import { ago, bytes, deg, duration, pct, rate } from "./format";
import { reportWidgetError, useMetrics, type Series } from "./store";
import type { MetricsData, WidgetConfig, WidgetType } from "./types";

// ── small building blocks ───────────────────────────────────────────────────

export function Sparkline({
  values,
  max,
  className = "",
}: {
  values: number[];
  max?: number;
  className?: string;
}) {
  const w = 56;
  const h = 20;
  if (values.length < 2) return <svg width={w} height={h} className={className} aria-hidden />;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 1 - (v / top) * (h - 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      <path d={`${line}L${w},${h}L0,${h}Z`} fill="color-mix(in srgb, var(--accent) 16%, transparent)" />
      <path
        d={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Bar({ value, label, detail }: { value: number | null | undefined; label: string; detail?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-ink">{label}</span>
        <span className="num text-ink-2">{detail ?? pct(value)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]">
        <div
          className={`h-full rounded-full ${v > 90 ? "bg-danger" : v > 75 ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${v}%`, transition: "width 0.6s ease" }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="num text-right text-ink">{value}</span>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-2">{children}</p>;
}

function Install({ cmd }: { cmd?: string }) {
  if (!cmd) return null;
  return (
    <p className="num rounded-[10px] bg-[var(--hairline)] px-2.5 py-1.5 text-xs break-all text-ink">{cmd}</p>
  );
}

// ── per-type definitions ────────────────────────────────────────────────────

export function weatherIcon(code: number | null | undefined, isDay = true): LucideIcon {
  if (code === null || code === undefined) return CloudSun;
  if (code <= 1) return isDay ? Sun : Moon;
  if (code === 2) return CloudSun;
  if (code === 3) return Cloud;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if (code >= 71 && code <= 77) return CloudSnow;
  if (code === 85 || code === 86) return CloudSnow;
  if (code >= 95) return CloudLightning;
  return CloudRain;
}

const MOOD_LABEL: Record<OrbMood, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  approval: "Needs you",
  error: "Offline",
};

interface Def {
  name: string;
  description: string;
  icon: LucideIcon;
  series?: Series;
  seriesMax?: number;
  /** Compact value text (null = icon/name only). */
  value: (d: MetricsData, w: WidgetConfig) => ReactNode;
  popover: (d: MetricsData, w: WidgetConfig) => ReactNode;
}

function mediaAction(action: string) {
  api(`/api/media/${action}`, { method: "POST" }).catch(reportWidgetError);
}

function ClockValue({ w }: { w: WidgetConfig }) {
  const seconds = w.options.seconds === true;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const step = seconds ? 1000 : 10_000;
    let t: number;
    const tick = () => {
      setNow(new Date());
      t = window.setTimeout(tick, step - (Date.now() % step) + 5);
    };
    t = window.setTimeout(tick, step - (Date.now() % step) + 5);
    return () => window.clearTimeout(t);
  }, [seconds]);
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
  });
  const date = now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const tz = typeof w.options.timezone === "string" && w.options.timezone ? w.options.timezone : null;
  let second: string | null = null;
  if (tz) {
    try {
      second = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz });
    } catch {
      second = null;
    }
  }
  return (
    <>
      <span className="num text-[15px] text-ink">{time}</span>
      <span className="text-sm text-ink-2">{date}</span>
      {second && w.size === "expanded" && (
        <span className="num text-sm text-ink-2">
          · {second} {tz!.split("/").pop()!.replace(/_/g, " ")}
        </span>
      )}
    </>
  );
}

function ClockPopover({ w }: { w: WidgetConfig }) {
  const now = new Date();
  const tz = typeof w.options.timezone === "string" ? w.options.timezone : "";
  let second = "";
  try {
    if (tz) second = now.toLocaleString(undefined, { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  } catch {
    second = "";
  }
  return (
    <>
      <p className="heading-display text-2xl text-ink">
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
      </p>
      <Stat label="Local time zone" value={Intl.DateTimeFormat().resolvedOptions().timeZone} />
      {second && <Stat label={tz.split("/").pop()!.replace(/_/g, " ")} value={second} />}
    </>
  );
}

function NotificationsPopover() {
  const history = useToasts((s) => s.history);
  const clear = useToasts((s) => s.clearHistory);
  const markRead = useToasts((s) => s.markRead);
  useEffect(() => markRead(), [markRead, history.length]);
  if (!history.length) return <Hint>You're all caught up.</Hint>;
  return (
    <>
      <ul className="-mx-1 flex max-h-72 flex-col gap-1 overflow-y-auto">
        {history.map((n) => (
          <li key={n.id} className="rounded-[10px] px-1 py-1.5">
            <p className="text-sm text-ink">{n.title}</p>
            {n.message && <p className="text-xs text-ink-2">{n.message}</p>}
            <p className="num text-[11px] text-ink-2">{n.at ? new Date(n.at).toLocaleTimeString() : ""}</p>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={clear}
        className="self-start rounded-full px-3 py-1 text-sm text-ink-2 hover:text-ink"
      >
        Clear all
      </button>
    </>
  );
}

export const WIDGETS: Record<WidgetType, Def> = {
  ai: {
    name: "Ember",
    description: "Model, state and pending approvals",
    icon: EmberGlyph,
    value: () => null,
    popover: (d) => (
      <>
        <Stat label="Model" value={d.ai?.model ?? "—"} />
        <Stat label="Server" value={d.ai ? (d.ai.reachable ? "Reachable" : "Not running") : "—"} />
        <Stat label="Tokens/s" value="—" />
        <Stat label="Pending approvals" value="0" />
        {d.ai && !d.ai.reachable && <Install cmd="local-ai run" />}
        <button
          type="button"
          onClick={() => useWM.getState().openApp("assistant")}
          className="hover-lift mt-1 self-start rounded-full bg-accent-fill px-4 py-1.5 text-sm text-on-accent"
        >
          Open Ember
        </button>
      </>
    ),
  },
  cpu: {
    name: "CPU",
    description: "Usage, temperature, frequency",
    icon: Cpu,
    series: "cpu",
    seriesMax: 100,
    value: (d) => pct(d.cpu?.usage),
    popover: (d) => (
      <>
        <Stat label="Usage" value={pct(d.cpu?.usage)} />
        <Stat label="Temperature" value={deg(d.cpu?.temp_c)} />
        <Stat label="Frequency" value={d.cpu?.freq_mhz ? `${(d.cpu.freq_mhz / 1000).toFixed(2)} GHz` : "—"} />
        {d.cpu?.per_core && (
          <div className="mt-1 grid grid-cols-8 gap-1" aria-label="Per-core usage">
            {d.cpu.per_core.map((c, i) => (
              <div
                key={i}
                className="flex h-8 flex-col justify-end overflow-hidden rounded-[4px] bg-[var(--hairline)]"
                title={`Core ${i}: ${pct(c)}`}
              >
                <div
                  className="w-full bg-accent"
                  style={{ height: `${Math.max(2, c)}%`, transition: "height .6s ease" }}
                />
              </div>
            ))}
          </div>
        )}
      </>
    ),
  },
  gpu: {
    name: "GPU",
    description: "Usage, temperature, VRAM",
    icon: Gpu,
    series: "gpu",
    seriesMax: 100,
    value: (d) => (d.gpu?.available === false ? "—" : `${pct(d.gpu?.usage)} · ${deg(d.gpu?.temp_c)}`),
    popover: (d) =>
      d.gpu?.available === false ? (
        <>
          <Hint>No supported GPU found.</Hint>
          <Install cmd={d.gpu.install} />
        </>
      ) : (
        <>
          <p className="text-sm text-ink">{d.gpu?.name ?? "GPU"}</p>
          <Stat label="Usage" value={pct(d.gpu?.usage)} />
          <Stat label="Temperature" value={deg(d.gpu?.temp_c)} />
          <Stat label="Power" value={d.gpu?.power_w ? `${Math.round(d.gpu.power_w)} W` : "—"} />
          <Bar
            label="VRAM"
            value={d.gpu?.vram_total_mb ? ((d.gpu.vram_used_mb ?? 0) / d.gpu.vram_total_mb) * 100 : null}
            detail={`${bytes((d.gpu?.vram_used_mb ?? 0) * 1048576)} / ${bytes((d.gpu?.vram_total_mb ?? 0) * 1048576)}`}
          />
        </>
      ),
  },
  memory: {
    name: "Memory",
    description: "RAM and swap",
    icon: MemoryStick,
    series: "memory",
    seriesMax: 100,
    value: (d) => pct(d.memory?.percent),
    popover: (d) => (
      <>
        <Bar
          label="RAM"
          value={d.memory?.percent}
          detail={`${bytes(d.memory?.used)} / ${bytes(d.memory?.total)}`}
        />
        <Bar
          label="Swap / zram"
          value={d.memory?.swap_percent}
          detail={`${bytes(d.memory?.swap_used)} / ${bytes(d.memory?.swap_total)}`}
        />
      </>
    ),
  },
  temps: {
    name: "Temperatures",
    description: "The hottest sensors",
    icon: Thermometer,
    series: "temps",
    value: (d) => deg(d.temps?.hottest?.current),
    popover: (d) =>
      d.temps?.sensors.length ? (
        <>
          {d.temps.sensors.map((s) => (
            <Stat key={s.label} label={s.label} value={deg(s.current)} />
          ))}
        </>
      ) : (
        <Hint>No temperature sensors reported.</Hint>
      ),
  },
  disk: {
    name: "Disk",
    description: "Usage and I/O",
    icon: HardDrive,
    series: "diskio",
    value: (d) => pct(d.disk?.mounts.find((m) => m.mount === "/home")?.percent ?? d.disk?.mounts[0]?.percent),
    popover: (d) => (
      <>
        {d.disk?.mounts.map((m) => (
          <Bar
            key={m.mount}
            label={m.mount}
            value={m.percent}
            detail={`${bytes(m.used)} / ${bytes(m.total)}`}
          />
        ))}
        <Stat label="Read" value={rate(d.disk?.read_bps)} />
        <Stat label="Write" value={rate(d.disk?.write_bps)} />
      </>
    ),
  },
  network: {
    name: "Network",
    description: "Throughput and Tailscale",
    icon: ArrowDownUp,
    series: "down",
    value: (d) => `↓ ${rate(d.network?.down_bps)}`,
    popover: (d) => {
      const ts = d.network?.tailscale;
      return (
        <>
          <Stat label="Download" value={rate(d.network?.down_bps)} />
          <Stat label="Upload" value={rate(d.network?.up_bps)} />
          <Stat
            label="Tailscale"
            value={!ts ? "—" : !ts.installed ? "Not installed" : ts.running ? "Connected" : "Stopped"}
          />
          {ts?.ip && <Stat label="Tailscale IP" value={ts.ip} />}
          {ts?.online_peers !== null && ts?.online_peers !== undefined && (
            <Stat label="Peers online" value={ts.online_peers} />
          )}
          {ts?.exit_node && <Stat label="Exit node" value={ts.exit_node} />}
          {ts && !ts.installed && <Install cmd={ts.install} />}
        </>
      );
    },
  },
  clock: {
    name: "Clock & date",
    description: "Optional seconds and a second time zone",
    icon: Timer,
    value: () => null,
    popover: (_d, w) => <ClockPopover w={w} />,
  },
  weather: {
    name: "Weather",
    description: "Current conditions and forecast",
    icon: CloudSun,
    value: (d) => (d.weather?.available ? deg(d.weather.temp_c) : "—"),
    popover: (d) => {
      const wx = d.weather;
      if (!wx?.available)
        return <Hint>{wx?.error ? `Weather unavailable: ${wx.error}` : "Loading weather…"}</Hint>;
      return (
        <>
          <div className="flex items-baseline justify-between">
            <p className="heading-display text-3xl text-ink">{deg(wx.temp_c)}</p>
            <p className="text-sm text-ink-2">{wx.city}</p>
          </div>
          <p className="text-sm text-ink">
            {wx.description} · H {deg(wx.high)} L {deg(wx.low)}
          </p>
          <div className="flex gap-4 text-sm text-ink-2">
            {wx.sunrise && (
              <span className="inline-flex items-center gap-1">
                <Sunrise className="size-4" strokeWidth={1.5} />
                <span className="num">{wx.sunrise.slice(11, 16)}</span>
              </span>
            )}
            {wx.sunset && (
              <span className="inline-flex items-center gap-1">
                <Sunset className="size-4" strokeWidth={1.5} />
                <span className="num">{wx.sunset.slice(11, 16)}</span>
              </span>
            )}
          </div>
          <div className="mt-1 grid grid-cols-4 gap-2">
            {wx.forecast?.slice(0, 4).map((f) => {
              const I = weatherIcon(f.code);
              return (
                <div
                  key={f.date}
                  className="flex flex-col items-center gap-1 rounded-[10px] bg-[var(--hairline)] py-2"
                  title={f.description}
                >
                  <span className="text-xs text-ink-2">
                    {new Date(`${f.date}T12:00`).toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <I className="size-5 text-accent-ink" strokeWidth={1.5} />
                  <span className="num text-xs text-ink">
                    {Math.round(f.max)}° <span className="text-ink-2">{Math.round(f.min)}°</span>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      );
    },
  },
  media: {
    name: "Media",
    description: "Now playing with controls",
    icon: Music2,
    value: (d) =>
      !d.media?.available
        ? "Off"
        : d.media.playing
          ? (d.media.playing.title ?? d.media.playing.status ?? "Playing")
          : "Quiet",
    popover: (d) => {
      const m = d.media;
      if (!m?.available)
        return (
          <>
            <Hint>Media control needs playerctl.</Hint>
            <Install cmd={m?.install ?? "sudo pacman -S playerctl"} />
          </>
        );
      if (!m.playing) return <Hint>Nothing is playing.</Hint>;
      const p = m.playing;
      return (
        <>
          {p.title && <p className="heading-display text-xl text-ink">{p.title}</p>}
          {(p.artist || p.album) && (
            <p className="text-sm text-ink-2">{[p.artist, p.album].filter(Boolean).join(" · ")}</p>
          )}
          <p className="text-xs text-ink-2">{p.player}</p>
          <div className="mt-1 flex items-center justify-center gap-2">
            {(
              [
                ["previous", SkipBack, "Previous"],
                ["play-pause", p.status === "Playing" ? Pause : Play, "Play or pause"],
                ["next", SkipForward, "Next"],
              ] as const
            ).map(([action, I, label]) => (
              <button
                key={action}
                type="button"
                onClick={() => mediaAction(action)}
                className="hover-lift grid size-10 place-items-center rounded-full bg-[var(--hairline)] text-ink"
                aria-label={label}
              >
                <I className="size-[18px]" strokeWidth={1.5} />
              </button>
            ))}
          </div>
        </>
      );
    },
  },
  updates: {
    name: "Updates",
    description: "Pending pacman and AUR updates",
    icon: Package,
    value: (d) => {
      const u = d.updates;
      if (!u || (u.repo === null && u.aur === null)) return "—";
      return String((u.repo ?? 0) + (u.aur ?? 0));
    },
    popover: (d) => {
      const u = d.updates;
      return (
        <>
          <Stat label="Repositories" value={u?.repo ?? "—"} />
          <Stat label="AUR" value={u?.aur ?? "—"} />
          <Stat label="Checked" value={u?.checking ? "Checking…" : ago(u?.checked_at)} />
          <Install cmd={u?.install} />
          <Hint>Ember will prepare and run updates with your approval (Phase 6/8).</Hint>
        </>
      );
    },
  },
  notifications: {
    name: "Notifications",
    description: "Unread count and history",
    icon: Bell,
    value: () => null,
    popover: () => <NotificationsPopover />,
  },
  battery: {
    name: "Battery",
    description: "Charge and time left",
    icon: BatteryMedium,
    value: (d) => (d.battery?.present ? pct(d.battery.percent) : "—"),
    popover: (d) =>
      d.battery?.present ? (
        <>
          <Bar label="Charge" value={d.battery.percent} />
          <Stat label="Power" value={d.battery.plugged ? "Plugged in" : "On battery"} />
          {d.battery.secs_left && <Stat label="Time left" value={duration(d.battery.secs_left)} />}
        </>
      ) : (
        <Hint>No battery on this machine.</Hint>
      ),
  },
  uptime: {
    name: "Uptime & load",
    description: "Time since boot and load average",
    icon: Timer,
    value: (d) => (d.uptime ? duration(d.uptime.uptime_s) : "—"),
    popover: (d) => (
      <>
        <Stat label="Up for" value={d.uptime ? duration(d.uptime.uptime_s) : "—"} />
        <Stat
          label="Load (1/5/15 min)"
          value={d.uptime ? d.uptime.load.map((l) => l.toFixed(2)).join("  ") : "—"}
        />
      </>
    ),
  },
};

// ── the pill ────────────────────────────────────────────────────────────────

interface WidgetProps {
  w: WidgetConfig;
  /** Taskbar: true; lock screen: false (no popovers, no actions). */
  interactive: boolean;
  /** Only the AI widget uses this: render the shared orb inside the pill. */
  withOrb?: boolean;
  placement?: "up" | "down";
  align?: "start" | "end";
  /** "pill": its own frosted pill (lock screen); "segment": a part of the shared tray pill. */
  variant?: "pill" | "segment";
}

export function Widget({
  w,
  interactive,
  withOrb = false,
  placement = "up",
  align = "end",
  variant = "pill",
}: WidgetProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const def = WIDGETS[w.type];
  const data = useMetrics((s) => s.data);
  const series = useMetrics((s) => (def.series ? s.history[def.series] : null));
  const mood = useUI((s) => s.orbMood);
  const assistant = useAuth((s) => s.assistantName);
  const unread = useToasts((s) => s.unread);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (open && anchorRef.current) setRect(anchorRef.current.getBoundingClientRect());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  let Icon = def.icon;
  if (w.type === "weather" && data.weather?.available)
    Icon = weatherIcon(data.weather.code, !!data.weather.is_day);
  if (w.type === "battery" && data.battery?.plugged) Icon = BatteryCharging;

  let body: ReactNode;
  if (w.type === "ai") {
    body = (
      <>
        {withOrb ? <OrbAnchor className="-ml-3 size-9" /> : null}
        <span className="text-[15px] font-medium text-ink">{assistant}</span>
        <span className={`text-sm ${mood === "approval" ? "text-warn-ink" : "text-ink-2"}`}>
          {data.ai && !data.ai.reachable ? "Offline" : MOOD_LABEL[mood]}
        </span>
      </>
    );
  } else if (w.type === "clock") {
    body = <ClockValue w={w} />;
  } else if (w.type === "notifications") {
    body = (
      <>
        <Icon className="size-[18px] text-ink-2" strokeWidth={1.5} />
        {unread > 0 && (
          <span className="num rounded-full bg-accent-fill px-1.5 text-xs text-on-accent">{unread}</span>
        )}
      </>
    );
  } else {
    const value = def.value(data, w);
    body = (
      <>
        <Icon className="size-[18px] shrink-0 text-ink-2" strokeWidth={1.5} />
        {value !== null && <span className="num max-w-[160px] truncate text-[15px] text-ink">{value}</span>}
        {w.size === "expanded" && series && <Sparkline values={series} max={def.seriesMax} />}
      </>
    );
  }

  const label = `${def.name}${typeof def.value(data, w) === "string" ? `: ${def.value(data, w) as string}` : ""}`;
  const Tag = interactive ? motion.button : motion.div;
  const pillClass =
    variant === "pill"
      ? `glass h-12 rounded-full px-4 ${interactive ? "hover-lift" : ""} ${w.type === "ai" && withOrb ? "pl-5" : ""}`
      : `h-10 rounded-full px-3 transition hover:bg-[var(--hairline)] ${open ? "bg-[var(--hairline)]" : ""} ${w.type === "ai" && withOrb ? "pl-4" : ""}`;
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const popStyle: React.CSSProperties = rect
    ? {
        position: "fixed",
        ...(placement === "up" ? { bottom: vh - rect.top + 10 } : { top: rect.bottom + 10 }),
        ...(align === "end"
          ? { right: Math.max(12, vw - rect.right) }
          : { left: Math.max(12, Math.min(rect.left, vw - 312)) }),
        transformOrigin: `${align === "end" ? "right" : "left"} ${placement === "up" ? "bottom" : "top"}`,
      }
    : {};
  return (
    <div ref={anchorRef} className="relative shrink-0">
      <Tag
        layoutId={`widget-${w.id}`}
        transition={spring}
        type={interactive ? "button" : undefined}
        onClick={interactive ? () => setOpen((o) => !o) : undefined}
        aria-expanded={interactive ? open : undefined}
        aria-label={w.type === "ai" ? `${assistant}: ${MOOD_LABEL[mood]}` : label}
        className={`flex items-center gap-2 whitespace-nowrap ${pillClass}`}
      >
        {body}
      </Tag>
      {createPortal(
        <AnimatePresence>
          {open && interactive && rect && (
            <>
              <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
              <motion.div
                role="dialog"
                aria-label={def.name}
                className="window z-[71] flex w-[300px] max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-[16px] p-4"
                style={popStyle}
                initial={{ opacity: 0, scale: 0.92, y: placement === "up" ? 8 : -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                transition={spring}
              >
                <p className="text-xs font-medium text-ink-2">{def.name}</p>
                {def.popover(data, w)}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
