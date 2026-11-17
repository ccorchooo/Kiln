import "@fontsource/jetbrains-mono/400.css";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookMarked,
  ChevronDown,
  ChevronUp,
  Columns2,
  Plus,
  Rows2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { spring } from "../../components/motion";
import { api, ApiError } from "../../lib/api";
import { useUI } from "../../lib/store";
import { toastError, useToasts } from "../../lib/toasts";
import { terminalTheme } from "../../theme/terminal";
import { useIsMobile } from "../../shell/hooks";
import type { AppProps } from "../../shell/apps";
import { useWM } from "../../shell/wm";
import {
  dropLayout,
  loadLayout,
  saveLayout,
  takePendingCommand,
  takePendingCwd,
  useTermPrefs,
  type TermLayout,
  type TermTab,
} from "./prefs";
import { Snippets } from "./Snippets";
import { TermView, type PaneStatus, type TermHandle } from "./TermView";

interface Created {
  id: string;
  title: string;
}

async function createTerm(cwd?: string | null, command?: string | null): Promise<string> {
  const r = await api<Created>("/api/terminals", {
    method: "POST",
    body: { cols: 100, rows: 30, cwd: cwd ?? undefined, command: command ?? undefined },
  });
  return r.id;
}

function killTerm(id: string): void {
  api(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

const tabId = () => Math.random().toString(36).slice(2, 10);

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-full transition ${active ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

function StatusOverlay({
  status,
  code,
  onNew,
  onClose,
  onTakeOver,
}: {
  status: PaneStatus;
  code: number | null;
  onNew: () => void;
  onClose: () => void;
  onTakeOver: () => void;
}) {
  if (status === "live" || status === "connecting") return null;
  const text: Record<string, string> = {
    exited: `The shell exited${code !== null ? ` with code ${code}` : ""}.`,
    gone: "This shell no longer exists on the server (it expired or the machine restarted).",
    elsewhere: "This shell is open in another window or device.",
    offline: "Reconnecting…",
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div className="glass pointer-events-auto flex items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-sm text-ink">
        {text[status]}
        {status === "elsewhere" && (
          <button
            type="button"
            onClick={onTakeOver}
            className="rounded-full bg-accent-fill px-3 py-1 text-on-accent"
          >
            Use here
          </button>
        )}
        {(status === "exited" || status === "gone") && (
          <>
            <button
              type="button"
              onClick={onNew}
              className="rounded-full bg-accent-fill px-3 py-1 text-on-accent"
            >
              New shell
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3 py-1 text-ink-2 hover:text-ink"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const KEYS: [string, ReactNode, string][] = [
  ["\x1b", "Esc", "Escape"],
  ["\t", "Tab", "Tab"],
  ["\x1b[A", <ArrowUp key="u" className="size-4" strokeWidth={1.5} />, "Up"],
  ["\x1b[B", <ArrowDown key="d" className="size-4" strokeWidth={1.5} />, "Down"],
  ["\x1b[D", <ArrowLeft key="l" className="size-4" strokeWidth={1.5} />, "Left"],
  ["\x1b[C", <ArrowRight key="r" className="size-4" strokeWidth={1.5} />, "Right"],
  ["|", "|", "Pipe"],
  ["~", "~", "Tilde"],
  ["/", "/", "Slash"],
];

export default function TerminalApp({ windowId }: AppProps) {
  const [layout, setLayout] = useState<TermLayout | null>(() => loadLayout(windowId));
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, { s: PaneStatus; code: number | null }>>({});
  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [mods, setMods] = useState({ ctrl: false, alt: false });
  const handles = useRef<Record<string, TermHandle | null>>({});
  const mobile = useIsMobile();
  const touch = useMemo(() => matchMedia("(pointer: coarse)").matches, []);
  const prefs = useTermPrefs();
  const termBg = terminalTheme(
    useUI((s) => s.themeId),
    useUI((s) => s.mode),
  ).background;

  const update = useCallback(
    (fn: (l: TermLayout) => TermLayout) =>
      setLayout((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        saveLayout(windowId, next);
        return next;
      }),
    [windowId],
  );

  // First open: one tab with one shell.
  useEffect(() => {
    if (layout?.tabs.length) return;
    let cancelled = false;
    createTerm(takePendingCwd(), takePendingCommand())
      .then((id) => {
        if (cancelled) return killTerm(id);
        const next: TermLayout = { tabs: [{ id: tabId(), panes: [id], split: "row", focus: 0 }], active: 0 };
        saveLayout(windowId, next);
        setLayout(next);
      })
      .catch((err) =>
        toastError(
          err instanceof ApiError && err.code === "too_many"
            ? "Too many open shells"
            : "Couldn't start a shell",
          err,
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [layout, windowId]);

  // Closing the window (not locking or reloading) ends its shells.
  useEffect(
    () =>
      useWM.subscribe((s, prev) => {
        if (prev.windows[windowId] && !s.windows[windowId]) {
          loadLayout(windowId)
            ?.tabs.flatMap((t) => t.panes)
            .forEach(killTerm);
          dropLayout(windowId);
        }
      }),
    [windowId],
  );

  const tab = layout?.tabs[layout.active];
  const activePane = tab ? tab.panes[Math.min(tab.focus, tab.panes.length - 1)] : undefined;
  const active = () => (activePane ? handles.current[activePane] : null);

  const newTab = async () => {
    try {
      const id = await createTerm();
      update((l) => ({
        tabs: [...l.tabs, { id: tabId(), panes: [id], split: "row", focus: 0 }],
        active: l.tabs.length,
      }));
    } catch (err) {
      toastError("Couldn't start a shell", err);
    }
  };

  const closeTab = (i: number) => {
    const t = layout?.tabs[i];
    if (!t) return;
    t.panes.forEach(killTerm);
    if (layout!.tabs.length === 1) {
      useWM.getState().closeWindow(windowId);
      return;
    }
    update((l) => {
      const tabs = l.tabs.filter((_, j) => j !== i);
      return { tabs, active: Math.min(l.active > i ? l.active - 1 : l.active, tabs.length - 1) };
    });
  };

  const toggleSplit = async () => {
    if (!tab) return;
    if (tab.panes.length === 1) {
      try {
        const id = await createTerm();
        update((l) => ({
          ...l,
          tabs: l.tabs.map((t, i) => (i === l.active ? { ...t, panes: [...t.panes, id], focus: 1 } : t)),
        }));
      } catch (err) {
        toastError("Couldn't start a shell", err);
      }
    } else {
      update((l) => ({
        ...l,
        tabs: l.tabs.map((t, i) => (i === l.active ? { ...t, split: t.split === "row" ? "col" : "row" } : t)),
      }));
    }
  };

  const closePane = (termId: string) => {
    killTerm(termId);
    const t = layout?.tabs.find((x) => x.panes.includes(termId));
    if (!t) return;
    if (t.panes.length === 1) return closeTab(layout!.tabs.indexOf(t));
    update((l) => ({
      ...l,
      tabs: l.tabs.map((x) => (x === t ? { ...x, panes: x.panes.filter((p) => p !== termId), focus: 0 } : x)),
    }));
  };

  const replacePane = async (termId: string) => {
    try {
      const id = await createTerm();
      update((l) => ({
        ...l,
        tabs: l.tabs.map((t) => ({ ...t, panes: t.panes.map((p) => (p === termId ? id : p)) })),
      }));
    } catch (err) {
      toastError("Couldn't start a shell", err);
    }
  };

  const askEmber = (kind: "explain" | "fix") => {
    const h = active();
    if (!h) return;
    const text = kind === "explain" ? h.selection() : h.tail(40);
    if (!text.trim()) {
      useToasts.getState().push({
        tone: "info",
        title: kind === "explain" ? "Select some text first" : "Nothing to look at yet",
      });
      return;
    }
    useWM
      .getState()
      .ask(
        kind === "explain"
          ? `Explain this terminal output:\n\n\`\`\`\n${text}\n\`\`\``
          : `The last command in my terminal failed. What went wrong and how do I fix it?\n\n\`\`\`\n${text}\n\`\`\``,
      );
  };

  const runSearch = (dir: "next" | "prev") => {
    if (query) active()?.search(query, dir);
  };

  const sendKey = (seq: string) => {
    const h = active();
    if (!h) return;
    h.send(seq);
    h.focus();
  };

  const toggleMod = (k: "ctrl" | "alt") => {
    const next = { ...mods, [k]: !mods[k] };
    setMods(next);
    active()?.setModifiers(next);
  };

  if (!layout || !tab)
    return <div className="grid h-full place-items-center text-sm text-ink-2">Starting a shell…</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Tabs + tools */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--hairline)] px-2 py-1.5">
        <div
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {layout.tabs.map((t: TermTab, i) => {
            const title =
              t.panes
                .map((p) => titles[p])
                .filter(Boolean)
                .join(" · ") || "Shell";
            const on = i === layout.active;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={on}
                tabIndex={0}
                onClick={() => update((l) => ({ ...l, active: i }))}
                onKeyDown={(e) => e.key === "Enter" && update((l) => ({ ...l, active: i }))}
                className={`group flex h-8 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-full pr-1 pl-3 text-sm ${on ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-[var(--hairline)]"}`}
              >
                <span className="num truncate text-[13px]">{title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(i);
                  }}
                  className={`grid size-6 place-items-center rounded-full hover:bg-[var(--hairline)] ${on ? "" : "opacity-0 group-hover:opacity-100"}`}
                  aria-label={`Close ${title}`}
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              </div>
            );
          })}
          <ToolButton label="New tab" onClick={() => void newTab()}>
            <Plus className="size-4" strokeWidth={1.5} />
          </ToolButton>
        </div>
        {!mobile && (
          <ToolButton
            label={tab.panes.length === 1 ? "Split" : tab.split === "row" ? "Stack panes" : "Side by side"}
            onClick={() => void toggleSplit()}
          >
            {tab.panes.length === 2 && tab.split === "row" ? (
              <Rows2 className="size-4" strokeWidth={1.5} />
            ) : (
              <Columns2 className="size-4" strokeWidth={1.5} />
            )}
          </ToolButton>
        )}
        <ToolButton
          label="Search (Ctrl+Shift+F)"
          active={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search className="size-4" strokeWidth={1.5} />
        </ToolButton>
        <ToolButton label="Snippets" active={drawer} onClick={() => setDrawer(!drawer)}>
          <BookMarked className="size-4" strokeWidth={1.5} />
        </ToolButton>
        <div className="relative">
          <ToolButton
            label="Terminal preferences"
            active={prefsOpen}
            onClick={() => setPrefsOpen(!prefsOpen)}
          >
            <SlidersHorizontal className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <AnimatePresence>
            {prefsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPrefsOpen(false)} />
                <motion.div
                  className="window absolute top-10 right-0 z-50 flex w-64 flex-col gap-3 rounded-[16px] p-4"
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={spring}
                >
                  <div className="flex items-center justify-between text-sm text-ink">
                    Font size
                    <span className="flex items-center gap-1">
                      <ToolButton label="Smaller" onClick={() => prefs.set({ fontSize: prefs.fontSize - 1 })}>
                        <ChevronDown className="size-4" strokeWidth={1.5} />
                      </ToolButton>
                      <span className="num w-6 text-center">{prefs.fontSize}</span>
                      <ToolButton label="Larger" onClick={() => prefs.set({ fontSize: prefs.fontSize + 1 })}>
                        <ChevronUp className="size-4" strokeWidth={1.5} />
                      </ToolButton>
                    </span>
                  </div>
                  <div className="flex gap-1 rounded-full bg-[var(--hairline)] p-1">
                    {(["geist", "jetbrains"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => prefs.set({ font: f })}
                        className={`flex-1 rounded-full py-1 text-xs ${prefs.font === f ? "bg-accent-fill text-on-accent" : "text-ink-2"}`}
                      >
                        {f === "geist" ? "Geist Mono" : "JetBrains Mono"}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={prefs.copyOnSelect}
                      onChange={(e) => prefs.set({ copyOnSelect: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                    Copy on select
                  </label>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {searchOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-3 py-1.5">
          <Search className="size-4 text-ink-2" strokeWidth={1.5} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") {
                setSearchOpen(false);
                active()?.clearSearch();
                active()?.focus();
              }
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            className="num min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
          <ToolButton label="Previous match" onClick={() => runSearch("prev")}>
            <ChevronUp className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <ToolButton label="Next match" onClick={() => runSearch("next")}>
            <ChevronDown className="size-4" strokeWidth={1.5} />
          </ToolButton>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Every tab stays mounted so its shells keep streaming; only the active one is shown. */}
        {layout.tabs.map((t, ti) => (
          <div
            key={t.id}
            className={`absolute inset-0 flex gap-px bg-[var(--hairline)] ${t.split === "row" ? "flex-row" : "flex-col"} ${ti === layout.active ? "" : "invisible"}`}
          >
            {t.panes.map((p, pi) => {
              const st = status[p];
              return (
                <div
                  key={p}
                  className="relative min-h-0 min-w-0 flex-1 p-2"
                  style={{ background: termBg }}
                  data-pane={p}
                >
                  <TermView
                    ref={(h) => {
                      handles.current[p] = h;
                    }}
                    termId={p}
                    focused={ti === layout.active && pi === t.focus}
                    onFocus={() =>
                      update((l) => ({ ...l, tabs: l.tabs.map((x) => (x === t ? { ...x, focus: pi } : x)) }))
                    }
                    onTitle={(title) => setTitles((s) => (s[p] === title ? s : { ...s, [p]: title }))}
                    onStatus={(s, code) => setStatus((m) => ({ ...m, [p]: { s, code: code ?? null } }))}
                    onContextMenu={(x, y) => setMenu({ x, y })}
                    onModifierUsed={() => setMods({ ctrl: false, alt: false })}
                    onSearchShortcut={() => setSearchOpen(true)}
                  />
                  {st && (
                    <StatusOverlay
                      status={st.s}
                      code={st.code}
                      onNew={() => void replacePane(p)}
                      onClose={() => closePane(p)}
                      onTakeOver={() => handles.current[p]?.takeOver()}
                    />
                  )}
                  {t.panes.length === 2 && (
                    <button
                      type="button"
                      onClick={() => closePane(p)}
                      className="glass absolute top-2 right-2 z-10 grid size-7 place-items-center rounded-full text-ink-2 opacity-0 transition hover:text-ink focus:opacity-100 [div:hover>&]:opacity-100"
                      aria-label="Close pane"
                    >
                      <X className="size-3.5" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <AnimatePresence>
          {drawer && (
            <motion.aside
              className="window absolute inset-y-2 right-2 z-20 w-[min(340px,calc(100%-16px))] overflow-hidden rounded-[16px]"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={spring}
            >
              <Snippets
                onRun={(cmd) => {
                  sendKey(`${cmd}\r`);
                  setDrawer(false);
                }}
                onInsert={(cmd) => sendKey(cmd)}
                onClose={() => setDrawer(false)}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {touch && (
        <div
          className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-t border-[var(--hairline)] px-2 py-1.5"
          aria-label="Extra keys"
        >
          {(["ctrl", "alt"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleMod(k)}
              aria-pressed={mods[k]}
              className={`num h-9 min-w-12 shrink-0 rounded-[10px] px-2 text-sm ${mods[k] ? "bg-accent-fill text-on-accent" : "bg-[var(--hairline)] text-ink"}`}
            >
              {k === "ctrl" ? "Ctrl" : "Alt"}
            </button>
          ))}
          {KEYS.map(([seq, label, name]) => (
            <button
              key={name}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => sendKey(seq)}
              aria-label={name}
              className="num grid h-9 min-w-10 shrink-0 place-items-center rounded-[10px] bg-[var(--hairline)] px-2 text-sm text-ink"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {createPortal(
        <AnimatePresence>
          {menu && (
            <>
              <div
                className="fixed inset-0 z-[70]"
                onClick={() => setMenu(null)}
                onContextMenu={(e) => (e.preventDefault(), setMenu(null))}
              />
              <motion.div
                role="menu"
                className="window fixed z-[71] w-56 rounded-[16px] p-1.5"
                style={{
                  left: Math.min(menu.x, window.innerWidth - 232),
                  top: Math.min(menu.y, window.innerHeight - 260),
                }}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
                transition={spring}
              >
                {(
                  [
                    ["Copy", () => active()?.copy()],
                    ["Paste", () => active()?.paste()],
                    ["Explain selection with Ember", () => askEmber("explain")],
                    ["Fix last error with Ember", () => askEmber("fix")],
                    ["Find…", () => setSearchOpen(true)],
                    ["Clear scrollback", () => active()?.clear()],
                  ] as const
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      fn();
                    }}
                    className="w-full rounded-[10px] px-3 py-2 text-left text-sm text-ink hover:bg-[var(--hairline)]"
                  >
                    {label}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
