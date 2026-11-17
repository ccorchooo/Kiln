import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { openTerminalWith } from "../terminal/open";
import { Empty, SearchBox, Tabs } from "./ui";

interface Info {
  installed: { name: string; version: string }[];
  updates: { name: string; from: string; to: string; aur: boolean }[];
  aur_helper: string | null;
}
interface Hit {
  repo: string;
  name: string;
  version: string;
  installed: boolean;
  description: string;
}

type View = "updates" | "installed" | "search";
const SAFE = /^[a-z0-9@._+-]+$/; // package names only ever reach the shell when they match this

function RunButton({ label, command }: { label: string; command: string }) {
  return (
    <button
      type="button"
      onClick={() => openTerminalWith(command)}
      title={`Opens a terminal and runs: ${command}`}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs text-ink-2 transition hover:bg-[var(--hairline)] hover:text-ink"
    >
      <SquareTerminal className="size-3.5" />
      {label}
    </button>
  );
}

export function Packages() {
  const [view, setView] = useState<View>("updates");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const info = useQuery({
    queryKey: ["system", "packages"],
    queryFn: () => api<Info>("/api/system/packages"),
    staleTime: 60_000,
  });
  const search = useQuery({
    queryKey: ["system", "packages", "search", deferred],
    queryFn: () => api<{ results: Hit[] }>(`/api/system/packages/search?q=${encodeURIComponent(deferred)}`),
    enabled: view === "search" && deferred.length >= 2,
    staleTime: 60_000,
  });
  const helper = info.data?.aur_helper;
  const installed = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (info.data?.installed ?? []).filter((p) => !f || p.name.includes(f));
  }, [info.data, filter]);
  const install = (h: Hit) =>
    h.repo === "aur" && helper ? `${helper} -S ${h.name}` : `sudo pacman -S ${h.name}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          label="Packages"
          value={view}
          onChange={setView}
          options={[
            ["updates", `Updates${info.data ? ` (${info.data.updates.length})` : ""}`],
            ["installed", "Installed"],
            ["search", "Find"],
          ]}
        />
        {view === "installed" && (
          <SearchBox value={filter} onChange={setFilter} label="Filter installed packages" />
        )}
        {view === "search" && (
          <SearchBox value={query} onChange={setQuery} label="Search the repositories and the AUR" />
        )}
      </div>

      {view === "updates" &&
        (!info.data ? (
          <Empty>Checking for updates…</Empty>
        ) : info.data.updates.length === 0 ? (
          <Empty>Everything is up to date.</Empty>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-[14px] bg-accent-soft px-3 py-2 text-sm text-ink">
              {info.data.updates.length} updates waiting.
              <span className="ml-auto">
                <RunButton label="Update everything" command={helper ? helper : "sudo pacman -Syu"} />
              </span>
            </div>
            <ul className="divide-y divide-[var(--hairline)]">
              {info.data.updates.map((u) => (
                <li key={u.name} className="flex items-center gap-3 py-2 text-sm">
                  <span className="text-ink">{u.name}</span>
                  {u.aur && (
                    <span className="rounded-full bg-[var(--hairline)] px-1.5 text-[10px] text-ink-2">
                      AUR
                    </span>
                  )}
                  <span className="num ml-auto text-xs text-ink-2">
                    {u.from} → <span className="text-ink">{u.to}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}

      {view === "installed" &&
        (!info.data ? (
          <Empty>Loading…</Empty>
        ) : (
          <>
            <p className="text-xs text-ink-2">
              {installed.length} packages you installed yourself (dependencies aren't listed).
            </p>
            <ul className="divide-y divide-[var(--hairline)]">
              {installed.slice(0, 300).map((p) => (
                <li key={p.name} className="group flex items-center gap-3 py-1.5 text-sm">
                  <span className="text-ink">{p.name}</span>
                  <span className="num text-xs text-ink-2">{p.version}</span>
                  <span className="ml-auto opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
                    {SAFE.test(p.name) && <RunButton label="Remove" command={`sudo pacman -Rns ${p.name}`} />}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}

      {view === "search" &&
        (deferred.length < 2 ? (
          <Empty>Type at least two letters.</Empty>
        ) : search.isLoading ? (
          <Empty>Searching…</Empty>
        ) : !search.data?.results.length ? (
          <Empty>Nothing found.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {search.data.results.map((h) => (
              <li key={`${h.repo}/${h.name}`} className="group flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {h.name} <span className="num text-xs text-ink-2">{h.version}</span>{" "}
                    <span className="rounded-full bg-[var(--hairline)] px-1.5 text-[10px] text-ink-2">
                      {h.repo}
                    </span>
                  </p>
                  <p className="truncate text-xs text-ink-2">{h.description}</p>
                </div>
                {h.installed ? (
                  <span className="text-xs text-success-ink">Installed</span>
                ) : (
                  SAFE.test(h.name) && <RunButton label="Install" command={install(h)} />
                )}
              </li>
            ))}
          </ul>
        ))}
      <p className="text-xs text-ink-2">
        Installing, removing and updating open a terminal and type the command there, so you see what pacman
        {helper ? ` and ${helper}` : ""} ask before anything changes.
      </p>
    </div>
  );
}
