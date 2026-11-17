import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { openLogs } from "../logs/pending";
import { ConfirmButton, Empty, SearchBox, Tabs, useRootAction } from "./ui";

interface Service {
  unit: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  enabled: string;
}

type Scope = "system" | "user";
type Show = "running" | "failed" | "all";
type Action = "start" | "stop" | "restart" | "enable" | "disable";

const STATE_STYLE: Record<string, string> = {
  active: "text-success-ink",
  failed: "text-danger-ink",
  activating: "text-warn-ink",
  deactivating: "text-warn-ink",
};

export function Services() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("system");
  const [show, setShow] = useState<Show>("running");
  const [q, setQ] = useState("");
  const user = scope === "user";
  const { data, error } = useQuery({
    queryKey: ["system", "services", scope],
    queryFn: () => api<{ services: Service[] }>(`/api/system/services?user=${user}`),
    refetchInterval: 5000,
  });
  const { act, prompt } = useRootAction(
    () => void qc.invalidateQueries({ queryKey: ["system", "services"] }),
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.services ?? []).filter(
      (s) =>
        (show === "all" || (show === "running" ? s.active === "active" : s.active === "failed")) &&
        (!needle || s.unit.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)),
    );
  }, [data, q, show]);

  const run = (s: Service, action: Action) =>
    act(`${action[0]!.toUpperCase()}${action.slice(1)} ${s.unit}`, (sudo_password) =>
      api(`/api/system/services/${encodeURIComponent(s.unit)}`, {
        method: "POST",
        body: { action, user, sudo_password: user ? undefined : sudo_password },
      }),
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          label="Scope"
          value={scope}
          onChange={setScope}
          options={[
            ["system", "System"],
            ["user", "Mine"],
          ]}
        />
        <Tabs
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            ["running", "Running"],
            ["failed", "Failed"],
            ["all", "All"],
          ]}
        />
        <SearchBox value={q} onChange={setQ} label="Search services" />
      </div>
      {prompt}
      {error ? (
        <Empty>Couldn't list services: {(error as Error).message}</Empty>
      ) : !data ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No services match.</Empty>
      ) : (
        <ul className="divide-y divide-[var(--hairline)]">
          {rows.map((s) => {
            const running = s.active === "active" || s.active === "activating";
            const canToggle = s.enabled === "enabled" || s.enabled === "disabled";
            return (
              <li key={s.unit} className="group flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="num truncate text-sm text-ink" title={s.unit}>
                    {s.unit}
                  </p>
                  {s.description && <p className="truncate text-xs text-ink-2">{s.description}</p>}
                </div>
                <span className={`w-28 shrink-0 text-xs ${STATE_STYLE[s.active] ?? "text-ink-2"}`}>
                  {s.active}
                  {s.sub && s.sub !== s.active ? ` · ${s.sub}` : ""}
                </span>
                <span className="w-24 shrink-0 truncate text-xs text-ink-2">{s.enabled}</span>
                {/* Takes no room until hover/focus, so names stay readable in a half-width window. */}
                <span className="flex max-w-0 shrink-0 justify-end gap-1 overflow-hidden opacity-0 transition-[opacity] group-focus-within:max-w-[320px] group-focus-within:opacity-100 group-hover:max-w-[320px] group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => openLogs({ unit: s.unit, user })}
                    className="flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
                  >
                    <ScrollText className="size-3.5" /> Logs
                  </button>
                  {running ? (
                    <>
                      <ConfirmButton
                        label="Restart"
                        confirm="Restart it?"
                        onConfirm={() => void run(s, "restart")}
                      />
                      <ConfirmButton
                        label="Stop"
                        confirm="Stop it?"
                        danger
                        onConfirm={() => void run(s, "stop")}
                      />
                    </>
                  ) : (
                    <ConfirmButton label="Start" confirm="Start it?" onConfirm={() => void run(s, "start")} />
                  )}
                  {canToggle && (
                    <ConfirmButton
                      label={s.enabled === "enabled" ? "Disable" : "Enable"}
                      confirm={s.enabled === "enabled" ? "Disable at boot?" : "Enable at boot?"}
                      onConfirm={() => void run(s, s.enabled === "enabled" ? "disable" : "enable")}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
