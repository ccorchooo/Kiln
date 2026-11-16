import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reorder } from "framer-motion";
import { GripVertical, Laptop, Lock, Monitor, PanelBottom, Power, Shield, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { lockNow, panicNow } from "../../lib/auth";
import { useUI, type QualityPref } from "../../lib/store";
import { toastError, useToasts } from "../../lib/toasts";
import { APP_ORDER, APPS, MAX_PINNED } from "../../shell/apps";
import { useWM } from "../../shell/wm";
import { applyAppearance, resolveQuality, type Appearance } from "../../theme/useAppearance";
import { useSettingsSection, type SettingsSection } from "./section";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Monitor }[] = [
  { id: "appearance", label: "Appearance", icon: Monitor },
  { id: "dock", label: "Dock", icon: PanelBottom },
  { id: "sessions", label: "Devices", icon: Laptop },
  { id: "security", label: "Security", icon: Shield },
];

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 rounded-full bg-[var(--hairline)] p-1"
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-full px-4 py-1.5 text-sm transition ${value === v ? "bg-accent-fill text-on-accent" : "text-ink-2 hover:text-ink"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--hairline)] py-5 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-[15px] font-medium text-ink">{title}</p>
        {hint && <p className="text-sm text-ink-2">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

async function saveAppearance(body: { mode?: string; quality?: string }) {
  try {
    const a = await api<Appearance>("/api/settings/appearance", { method: "PUT", body });
    applyAppearance(a);
    useUI
      .getState()
      .set({ modePreference: a.preference, qualityPref: a.quality, quality: resolveQuality(a.quality) });
  } catch (err) {
    toastError("Couldn't save appearance", err);
  }
}

function AppearanceSection() {
  const pref = useUI((s) => s.modePreference);
  const quality = useUI((s) => s.qualityPref);
  const effective = useUI((s) => s.quality);
  return (
    <>
      <Row title="Light and dark" hint="Automatic follows sunrise and sunset where you are.">
        <Segmented
          label="Light and dark"
          value={pref}
          onChange={(mode) => void saveAppearance({ mode })}
          options={[
            ["auto", "Automatic"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
      </Row>
      <Row title="Graphics quality" hint={`Currently ${effective}. Automatic steps down if frames drop.`}>
        <Segmented<QualityPref>
          label="Graphics quality"
          value={quality}
          onChange={(q) => void saveAppearance({ quality: q })}
          options={[
            ["auto", "Auto"],
            ["high", "High"],
            ["balanced", "Balanced"],
            ["low", "Low"],
            ["off", "Off"],
          ]}
        />
      </Row>
      <Row title="Themes" hint="Oat, Cinder, Sage, Dusk, Graphite and a theme editor arrive in Phase 9.">
        <span className="text-sm text-ink-2">Clay</span>
      </Row>
    </>
  );
}

function DockSection() {
  const pinned = useWM((s) => s.pinned);
  const unpinned = APP_ORDER.filter((id) => !pinned.includes(id));
  return (
    <>
      <p className="py-4 text-sm text-ink-2">
        Pin up to {MAX_PINNED} apps. Drag to reorder here or right in the dock; everything else is in Search.
      </p>
      <Reorder.Group
        axis="y"
        values={pinned}
        onReorder={(ids) => useWM.getState().setPinned(ids)}
        className="flex flex-col gap-2"
      >
        {pinned.map((id) => {
          const a = APPS[id]!;
          const Icon = a.icon;
          return (
            <Reorder.Item
              key={id}
              value={id}
              className="flex cursor-grab items-center gap-3 rounded-[16px] bg-[var(--hairline)] px-3 py-2.5 active:cursor-grabbing"
            >
              <GripVertical className="size-4 text-ink-2" strokeWidth={1.5} />
              <Icon className="size-[18px] text-accent-ink" strokeWidth={1.5} />
              <span className="flex-1 text-[15px] text-ink">{a.name}</span>
              <button
                type="button"
                className="rounded-full px-3 py-1 text-sm text-ink-2 hover:text-ink"
                onClick={() => useWM.getState().togglePin(id)}
              >
                Unpin
              </button>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
      {unpinned.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {unpinned.map((id) => {
            const a = APPS[id]!;
            const Icon = a.icon;
            const full = pinned.length >= MAX_PINNED;
            return (
              <button
                key={id}
                type="button"
                disabled={full}
                onClick={() => useWM.getState().togglePin(id)}
                className="hover-lift inline-flex items-center gap-2 rounded-full border border-[var(--hairline-strong)] px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              >
                <Icon className="size-4" strokeWidth={1.5} /> Pin {a.name}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

interface SessionInfo {
  id: string;
  created_at: number;
  last_seen: number;
  locked: boolean;
  ip: string;
  user_agent: string;
  current: boolean;
}

function device(ua: string): { label: string; mobile: boolean } {
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { label: `${browser}${os ? ` on ${os}` : ""}`, mobile };
}

function SessionsSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionInfo[]>("/api/auth/sessions"),
  });
  const revoke = async (id: string) => {
    try {
      await api(`/api/auth/sessions/${id}`, { method: "DELETE" });
      useToasts.getState().push({ tone: "success", title: "Signed out that device" });
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toastError("Couldn't sign out that device", err);
    }
  };
  if (isLoading) return <p className="py-4 text-sm text-ink-2">Loading…</p>;
  if (error) return <p className="py-4 text-sm text-danger-ink">Couldn't load sessions.</p>;
  return (
    <ul className="flex flex-col gap-2 py-4">
      {data?.map((s) => {
        const d = device(s.user_agent);
        const Icon = d.mobile ? Smartphone : Laptop;
        return (
          <li key={s.id} className="flex items-center gap-3 rounded-[16px] bg-[var(--hairline)] px-4 py-3">
            <Icon className="size-5 text-ink-2" strokeWidth={1.5} />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] text-ink">
                {d.label} {s.current && <span className="text-sm text-accent-ink">· this device</span>}
              </p>
              <p className="num truncate text-xs text-ink-2">
                {s.ip} · last seen {new Date(s.last_seen * 1000).toLocaleString()}
                {s.locked ? " · locked" : ""}
              </p>
            </div>
            {!s.current && (
              <button
                type="button"
                onClick={() => void revoke(s.id)}
                className="rounded-full px-3 py-1.5 text-sm text-danger-ink hover:bg-[var(--hairline)]"
              >
                Sign out
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SecuritySection() {
  return (
    <>
      <Row title="Lock now" hint="Ctrl+Alt+L. Apps stay open behind your password.">
        <button
          type="button"
          onClick={() => void lockNow()}
          className="hover-lift inline-flex items-center gap-2 rounded-full bg-[var(--hairline)] px-4 py-2 text-sm text-ink"
        >
          <Lock className="size-4" strokeWidth={1.5} /> Lock
        </button>
      </Row>
      <Row
        title="Panic lock"
        hint="Ctrl+Alt+Shift+K. Ends every session on every device and kills terminals."
      >
        <button
          type="button"
          onClick={() => void panicNow()}
          className="hover-lift inline-flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] px-4 py-2 text-sm text-danger-ink"
        >
          <Power className="size-4" strokeWidth={1.5} /> Panic
        </button>
      </Row>
      <Row
        title="Password, two-factor and audit log"
        hint="Coming to this page with the widgets work in Phase 3. Use `kiln set-password` and `kiln totp enable` meanwhile."
      >
        <span />
      </Row>
    </>
  );
}

export default function SettingsApp() {
  const section = useSettingsSection((s) => s.section);
  const setSection = useSettingsSection((s) => s.set);
  return (
    <div className="flex h-full flex-col sm:flex-row">
      <nav
        className="flex shrink-0 gap-1 overflow-x-auto p-3 sm:w-52 sm:flex-col"
        aria-label="Settings sections"
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            aria-current={section === id}
            className={`flex items-center gap-2.5 rounded-full px-4 py-2 text-left text-sm whitespace-nowrap transition ${section === id ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:text-ink"}`}
          >
            <Icon className="size-4" strokeWidth={1.5} />
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <h2 className="heading-display pt-5 text-3xl text-ink">
          {SECTIONS.find((s) => s.id === section)?.label}
        </h2>
        {section === "appearance" && <AppearanceSection />}
        {section === "dock" && <DockSection />}
        {section === "sessions" && <SessionsSection />}
        {section === "security" && <SecuritySection />}
      </div>
    </div>
  );
}
