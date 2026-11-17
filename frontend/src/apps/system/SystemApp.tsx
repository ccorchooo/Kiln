/**
 * System: a live overview plus processes, services, packages, network, storage and power.
 * Reads poll the server; actions need a fresh Kiln password, and root actions a one-shot sudo
 * password (see useRootAction). Package changes run in a Terminal, where sudo and AUR prompts work.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BatteryMedium,
  Box,
  Cog,
  FolderOpen,
  Gauge,
  HardDrive,
  Lock,
  Moon,
  Network as NetworkIcon,
  Power as PowerIcon,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../../lib/api";
import { lockNow } from "../../lib/auth";
import { bytes, deg, duration, pct, rate } from "../../widgets/format";
import { useMetrics, useMetricTopics } from "../../widgets/store";
import { openInFiles } from "../files/pending";
import { Packages } from "./Packages";
import { Processes } from "./Processes";
import { Services } from "./Services";
import { Bar, Card, Chart, ConfirmButton, Empty, useRootAction } from "./ui";

type Section = "overview" | "processes" | "services" | "packages" | "network" | "storage" | "power";

const SECTIONS: [Section, string, LucideIcon][] = [
  ["overview", "Overview", Gauge],
  ["processes", "Processes", Activity],
  ["services", "Services", Cog],
  ["packages", "Packages", Box],
  ["network", "Network", NetworkIcon],
  ["storage", "Storage", HardDrive],
  ["power", "Power", PowerIcon],
];

export default function SystemApp() {
  const [section, setSection] = useState<Section>("overview");
  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="System sections"
        className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-hairline p-2"
      >
        {SECTIONS.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
            className={`flex h-9 items-center gap-2.5 rounded-[12px] px-3 text-sm transition ${
              section === id
                ? "bg-accent-soft text-accent-ink"
                : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
            }`}
          >
            <Icon className="size-4" strokeWidth={1.5} />
            {label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === "overview" && <Overview />}
        {section === "processes" && <Processes />}
        {section === "services" && <Services />}
        {section === "packages" && <Packages />}
        {section === "network" && <Network />}
        {section === "storage" && <Storage />}
        {section === "power" && <Power />}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="num text-ink">{value}</span>
    </div>
  );
}

function Overview() {
  useMetricTopics(["cpu", "memory", "gpu", "temps", "disk", "network", "uptime", "battery", "updates"]);
  const d = useMetrics((s) => s.data);
  const h = useMetrics((s) => s.history);
  const { cpu, memory: mem, gpu, temps, disk, network: net, uptime, battery, updates } = d;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
      <Card title="Processor" extra={<span className="num text-2xl text-ink">{pct(cpu?.usage)}</span>}>
        <Chart values={h.cpu} max={100} />
        <div className="mt-3 flex h-8 items-end gap-px" aria-label="Per-core usage">
          {(cpu?.per_core ?? []).map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-[2px] bg-accent/70"
              style={{ height: `${Math.max(4, v)}%` }}
            />
          ))}
        </div>
        <div className="mt-3 space-y-1">
          <Stat label="Frequency" value={cpu?.freq_mhz ? `${(cpu.freq_mhz / 1000).toFixed(2)} GHz` : "—"} />
          <Stat label="Temperature" value={deg(cpu?.temp_c)} />
          <Stat
            label="Load (1, 5, 15 min)"
            value={uptime ? uptime.load.map((l) => l?.toFixed(2) ?? "—").join("  ") : "—"}
          />
        </div>
      </Card>
      <Card title="Memory" extra={<span className="num text-2xl text-ink">{pct(mem?.percent)}</span>}>
        <Chart values={h.memory} max={100} />
        <div className="mt-3 space-y-2">
          <Stat label="Used" value={mem ? `${bytes(mem.used)} of ${bytes(mem.total)}` : "—"} />
          <Bar value={mem?.percent} />
          <Stat label="Swap" value={mem ? `${bytes(mem.swap_used)} of ${bytes(mem.swap_total)}` : "—"} />
          <Bar value={mem?.swap_percent} />
        </div>
      </Card>
      <Card
        title={gpu?.name ?? "Graphics"}
        extra={<span className="num text-2xl text-ink">{pct(gpu?.usage)}</span>}
      >
        {gpu && !gpu.available ? (
          <p className="text-sm text-ink-2">No GPU telemetry. {gpu.install}</p>
        ) : (
          <>
            <Chart values={h.gpu} max={100} />
            <div className="mt-3 space-y-1">
              <Stat
                label="Video memory"
                value={
                  gpu?.vram_total_mb
                    ? `${bytes((gpu.vram_used_mb ?? 0) * 2 ** 20)} of ${bytes(gpu.vram_total_mb * 2 ** 20)}`
                    : "—"
                }
              />
              <Stat label="Temperature" value={deg(gpu?.temp_c)} />
              <Stat label="Power" value={gpu?.power_w ? `${Math.round(gpu.power_w)} W` : "—"} />
            </div>
          </>
        )}
      </Card>
      <Card title="Network">
        <Chart values={h.down} />
        <div className="mt-3 space-y-1">
          <Stat label="Download" value={rate(net?.down_bps)} />
          <Stat label="Upload" value={rate(net?.up_bps)} />
          <Stat
            label="Tailscale"
            value={
              net?.tailscale.running
                ? `${net.tailscale.ip ?? "on"} · ${net.tailscale.online_peers ?? 0} online`
                : "off"
            }
          />
        </div>
      </Card>
      <Card title="Disks">
        <div className="space-y-2">
          {(disk?.mounts ?? []).map((m) => (
            <div key={m.mount} className="space-y-1">
              <Stat label={m.mount} value={`${bytes(m.used)} of ${bytes(m.total)}`} />
              <Bar value={m.percent} />
            </div>
          ))}
          <Stat label="Read" value={rate(disk?.read_bps)} />
          <Stat label="Write" value={rate(disk?.write_bps)} />
        </div>
      </Card>
      <Card title="Temperatures">
        <div className="space-y-1">
          {(temps?.sensors ?? []).map((s) => (
            <Stat key={s.label} label={s.label} value={deg(s.current)} />
          ))}
          {!temps?.sensors.length && <p className="text-sm text-ink-2">No sensors found.</p>}
        </div>
      </Card>
      <Card title="This machine">
        <div className="space-y-1">
          <Stat label="Up for" value={uptime ? duration(uptime.uptime_s) : "—"} />
          <Stat
            label="Updates"
            value={updates?.available ? `${(updates.repo ?? 0) + (updates.aur ?? 0)} waiting` : "—"}
          />
          {battery?.present && (
            <Stat label="Battery" value={`${pct(battery.percent)}${battery.plugged ? " · charging" : ""}`} />
          )}
        </div>
      </Card>
    </div>
  );
}

interface Iface {
  name: string;
  up: boolean;
  speed_mbps: number | null;
  mtu: number | null;
  addresses: { family: "ipv4" | "ipv6" | "mac"; address: string }[];
  rx: number;
  tx: number;
}
interface Peer {
  name: string;
  ip: string | null;
  os: string;
  online: boolean;
  exit_node: boolean;
}

function Network() {
  const prev = useRef<{ at: number; io: Record<string, [number, number]> } | null>(null);
  const [rates, setRates] = useState<Record<string, [number, number]>>({});
  const { data } = useQuery({
    queryKey: ["system", "network"],
    queryFn: async () => {
      const r = await api<{ interfaces: Iface[]; tailscale: Peer[] | null; at: number }>(
        "/api/system/network",
      );
      const io = Object.fromEntries(r.interfaces.map((i) => [i.name, [i.rx, i.tx] as [number, number]]));
      const p = prev.current;
      if (p && r.at > p.at)
        setRates(
          Object.fromEntries(
            Object.entries(io).map(([n, [rx, tx]]) => {
              const [prx, ptx] = p.io[n] ?? [rx, tx];
              return [n, [(rx - prx) / (r.at - p.at), (tx - ptx) / (r.at - p.at)]];
            }),
          ),
        );
      prev.current = { at: r.at, io };
      return r;
    },
    refetchInterval: 2000,
  });
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {data.interfaces.map((i) => (
          <Card
            key={i.name}
            title={<span className="num">{i.name}</span>}
            extra={
              <span className={`text-xs ${i.up ? "text-success-ink" : "text-ink-2"}`}>
                {i.up ? "Up" : "Down"}
              </span>
            }
          >
            <div className="space-y-1">
              {i.addresses.map((a) => (
                <Stat
                  key={a.family + a.address}
                  label={a.family === "mac" ? "MAC" : a.family.toUpperCase()}
                  value={a.address}
                />
              ))}
              {i.speed_mbps && <Stat label="Link" value={`${i.speed_mbps} Mb/s`} />}
              <Stat label="Down / up" value={`${rate(rates[i.name]?.[0])} · ${rate(rates[i.name]?.[1])}`} />
              <Stat label="Total" value={`${bytes(i.rx)} · ${bytes(i.tx)}`} />
            </div>
          </Card>
        ))}
      </div>
      <Card title="Tailscale">
        {data.tailscale === null ? (
          <p className="text-sm text-ink-2">Tailscale isn't installed.</p>
        ) : data.tailscale.length === 0 ? (
          <p className="text-sm text-ink-2">No other devices (or Tailscale isn't running).</p>
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {data.tailscale.map((p) => (
              <li key={p.name + p.ip} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={`size-2 rounded-full ${p.online ? "bg-success" : "bg-[var(--hairline-strong)]"}`}
                />
                <span className="text-ink">{p.name}</span>
                <span className="text-ink-2">{p.os}</span>
                {p.exit_node && (
                  <span className="rounded-full bg-accent-soft px-2 text-[11px] text-accent-ink">
                    exit node
                  </span>
                )}
                <span className="num ml-auto text-ink-2">{p.ip}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

interface Partition {
  device: string;
  mounts: string[];
  fstype: string;
  used: number;
  total: number;
  percent: number;
}
interface Disk {
  name: string;
  size: number;
  model: string;
  kind: string;
  transport: string;
}

function Storage() {
  const { data } = useQuery({
    queryKey: ["system", "storage"],
    queryFn: () => api<{ partitions: Partition[]; disks: Disk[] }>("/api/system/storage"),
    refetchInterval: 10000,
  });
  if (!data) return <Empty>Loading…</Empty>;
  // Your home folder lives on /home if it is its own mount, else on /.
  const homeMount = data.partitions.some((p) => p.mounts.includes("/home")) ? "/home" : "/";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {data.partitions.map((p) => {
          const inHome = p.mounts.includes(homeMount);
          return (
            <Card
              key={p.device}
              title={<span className="num">{p.mounts[0]}</span>}
              extra={
                inHome ? (
                  <button
                    type="button"
                    onClick={() => openInFiles("~")}
                    className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
                  >
                    <FolderOpen className="size-3.5" /> Open home
                  </button>
                ) : null
              }
            >
              <div className="space-y-1.5">
                <Stat label="Used" value={`${bytes(p.used)} of ${bytes(p.total)}`} />
                <Bar value={p.percent} />
                <Stat label="Device" value={`${p.device} · ${p.fstype}`} />
                {p.mounts.length > 1 && (
                  <p className="num truncate text-xs text-ink-2" title={p.mounts.join(", ")}>
                    Also {p.mounts.slice(1).join(", ")}
                  </p>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <Card title="Drives">
        <ul className="divide-y divide-[var(--hairline)]">
          {data.disks.map((d) => (
            <li key={d.name} className="flex items-center gap-3 py-2 text-sm">
              <HardDrive className="size-4 text-ink-2" strokeWidth={1.5} />
              <span className="text-ink">{d.model || d.name}</span>
              <span className="text-ink-2">
                {d.kind}
                {d.transport ? ` · ${d.transport.toUpperCase()}` : ""}
              </span>
              <span className="num ml-auto text-ink-2">{bytes(d.size)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Power() {
  useMetricTopics(["uptime", "battery"]);
  const uptime = useMetrics((s) => s.data.uptime);
  const battery = useMetrics((s) => s.data.battery);
  const { act, prompt } = useRootAction();
  const power = (action: "suspend" | "reboot" | "poweroff", label: string) =>
    act(label, (sudo_password) =>
      api(`/api/system/power/${action}`, { method: "POST", body: { sudo_password } }),
    );
  const actions: [string, string, LucideIcon, () => void, boolean][] = [
    ["Lock", "Lock now", Lock, () => void lockNow(), false],
    ["Suspend", "Suspend now", Moon, () => void power("suspend", "Suspend"), false],
    ["Restart", "Restart now", RotateCcw, () => void power("reboot", "Restart"), true],
    ["Power off", "Power off now", PowerIcon, () => void power("poweroff", "Power off"), true],
  ];
  return (
    <div className="max-w-2xl space-y-3">
      {prompt}
      <Card title="Power">
        <div className="space-y-1">
          <Stat label="Up for" value={uptime ? duration(uptime.uptime_s) : "—"} />
          {battery?.present ? (
            <Stat
              label="Battery"
              value={`${pct(battery.percent)}${battery.plugged ? " · plugged in" : battery.secs_left ? ` · ${duration(battery.secs_left)} left` : ""}`}
            />
          ) : (
            <Stat label="Battery" value="None (desktop)" />
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {actions.map(([label, confirm, Icon, run, danger]) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2 rounded-[14px] border border-hairline p-3"
            >
              <Icon className={`size-5 ${danger ? "text-danger-ink" : "text-ink-2"}`} strokeWidth={1.5} />
              <ConfirmButton label={label} confirm={confirm} danger={danger} onConfirm={run} />
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-2">
          <BatteryMedium className="size-3.5" /> Restart and power off end every session, Kiln included.
        </p>
      </Card>
    </div>
  );
}
