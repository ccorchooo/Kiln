import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, Pin, PinOff, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { spring } from "../components/motion";
import { useAuth } from "../lib/store";
import { useToasts } from "../lib/toasts";
import { APPS, MAX_PINNED } from "./apps";
import { askResult, search, type Result } from "./search";
import { useWM } from "./wm";

function Preview({ r }: { r: Result | undefined }) {
  const pinned = useWM((s) => s.pinned);
  if (!r) return null;
  const Icon = r.icon;
  const app = r.appId ? APPS[r.appId] : undefined;
  const isPinned = !!r.appId && pinned.includes(r.appId);
  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="grid size-12 place-items-center rounded-[16px] bg-accent-soft text-accent-ink">
        <Icon className="size-6" strokeWidth={1.5} />
      </div>
      <h3 className="heading-display text-2xl text-ink">{r.title}</h3>
      {r.subtitle && <p className="text-sm text-ink-2">{r.subtitle}</p>}
      {r.detail && <p className="text-sm text-ink-2">{r.detail}</p>}
      {app && (
        <p className="text-sm text-ink-2">
          {app.pairable ? "Can share a workspace with another app." : "Gets its own workspace."}
        </p>
      )}
      {r.appId && (
        <button
          type="button"
          className="hover-lift mt-auto inline-flex w-fit items-center gap-2 rounded-full bg-[var(--hairline)] px-4 py-2 text-sm text-ink"
          onClick={() => {
            if (!useWM.getState().togglePin(r.appId!))
              useToasts.getState().push({
                tone: "warn",
                title: `The dock holds ${MAX_PINNED} apps`,
                message: "Unpin one first.",
              });
          }}
        >
          {isPinned ? (
            <PinOff className="size-4" strokeWidth={1.5} />
          ) : (
            <Pin className="size-4" strokeWidth={1.5} />
          )}
          {isPinned ? "Unpin from dock" : "Pin to dock"}
        </button>
      )}
    </div>
  );
}

function resultsFor(q: string): Result[] {
  const found = search(q);
  return q.trim() ? [...found, askResult(q.trim())] : found;
}

export function Spotlight() {
  const open = useWM((s) => s.spotlight);
  const assistant = useAuth((s) => s.assistantName);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => (open ? resultsFor(q) : []), [q, open]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const close = () => {
    inputRef.current?.blur();
    useWM.getState().setSpotlight(false);
  };
  const run = (r: Result | undefined) => {
    if (!r) return;
    close();
    r.run();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // The input stays mounted during the exit animation; ignore keys once closing.
    if (!useWM.getState().spotlight) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Use the input's live value: a fast typist can press Enter before the list re-renders.
      const live = e.currentTarget.value;
      run(live === q ? results[sel] : resultsFor(live)[0]);
    } else if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && q.trim()) {
      e.preventDefault();
      run(askResult(q.trim()));
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  let lastSection = "";
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="spot-bg"
            className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--bg)_25%,transparent)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
          <motion.div
            key="spot"
            role="dialog"
            aria-label="Search"
            className="window fixed top-[14vh] left-1/2 z-50 flex max-h-[min(560px,70vh)] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[24px]"
            initial={{ opacity: 0, y: 120, scale: 0.94, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 80, scale: 0.96, filter: "blur(8px)", transition: { duration: 0.2 } }}
            transition={spring}
            style={{ transformOrigin: "50% 100%" }}
          >
            <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-5">
              <Search className="size-5 shrink-0 text-ink-2" strokeWidth={1.5} />
              <input
                ref={inputRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search or ask…"
                className="heading-display h-16 min-w-0 flex-1 bg-transparent text-2xl text-ink outline-none"
                role="combobox"
                aria-expanded
                aria-controls="spot-list"
                aria-activedescendant={results[sel] ? `spot-${results[sel].id}` : undefined}
                aria-autocomplete="list"
              />
            </div>
            <div className="flex min-h-0 flex-1">
              <ul
                id="spot-list"
                ref={listRef}
                role="listbox"
                className="min-h-0 flex-1 overflow-y-auto p-2 md:max-w-[56%]"
              >
                {results.map((r, i) => {
                  const Icon = r.icon;
                  const header = r.section !== lastSection && r.id !== "ask" ? r.section : null;
                  lastSection = r.section;
                  return (
                    <li key={r.id} role="presentation">
                      {header && <p className="px-3 pt-3 pb-1 text-xs font-medium text-ink-2">{header}</p>}
                      <div
                        id={`spot-${r.id}`}
                        data-idx={i}
                        role="option"
                        aria-selected={i === sel}
                        onMouseMove={() => setSel(i)}
                        onClick={() => run(r)}
                        className={`flex cursor-pointer items-center gap-3 rounded-[16px] px-3 py-2.5 ${i === sel ? "bg-accent-soft" : ""}`}
                      >
                        <Icon
                          className={`size-[18px] shrink-0 ${i === sel ? "text-accent-ink" : "text-ink-2"}`}
                          strokeWidth={1.5}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] text-ink">{r.title}</span>
                          {r.subtitle && (
                            <span className="block truncate text-xs text-ink-2">{r.subtitle}</span>
                          )}
                        </span>
                        {i === sel && (
                          <CornerDownLeft className="size-4 shrink-0 text-ink-2" strokeWidth={1.5} />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="hidden min-h-0 flex-1 border-l border-[var(--hairline)] md:block">
                <Preview r={results[sel]} />
              </div>
            </div>
            <div className="flex gap-4 border-t border-[var(--hairline)] px-5 py-2.5 text-xs text-ink-2">
              <span>
                <kbd className="num">↑↓</kbd> move
              </span>
              <span>
                <kbd className="num">↵</kbd> open
              </span>
              <span>
                <kbd className="num">⇥</kbd> ask {assistant}
              </span>
              <span>
                <kbd className="num">esc</kbd> close
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
