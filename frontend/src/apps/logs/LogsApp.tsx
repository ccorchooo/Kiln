/**
 * Logs: the journal, live (`journalctl -f` over /ws/logs). Filters restart the stream;
 * pausing keeps the socket but stops appending, so the view holds still while you read.
 */
import { ArrowDownToLine, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EMPTY_FILTER, takePendingFilter, type LogFilter } from "./pending";

interface Entry {
  t: number;
  prio: number;
  unit: string;
  ident: string;
  pid: string | null;
  msg: string;
}

const MAX = 4000;
const PRIO_STYLE = [
  "text-danger-ink",
  "text-danger-ink",
  "text-danger-ink",
  "text-danger-ink",
  "text-warn-ink",
];
const PRIOS: [string, string][] = [
  ["", "Any level"],
  ["err", "Errors"],
  ["warning", "Warnings and up"],
  ["notice", "Notices and up"],
  ["info", "Info and up"],
];
const SINCE: [string, string][] = [
  ["", "Latest"],
  ["-15min", "Last 15 min"],
  ["-1h", "Last hour"],
  ["today", "Today"],
  ["-7d", "Last week"],
];

const field =
  "h-8 rounded-full border border-hairline bg-transparent px-3 text-sm text-ink outline-none focus:border-accent";

export default function LogsApp() {
  const [filter, setFilter] = useState<LogFilter>(() => ({ ...EMPTY_FILTER, ...takePendingFilter() }));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "ended" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [heldN, setHeldN] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const pausedRef = useRef(paused);
  const held = useRef<Entry[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  // One socket per window; filters are sent over it (debounced while typing).
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws/logs`);
    ws.current = sock;
    sock.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; entries?: Entry[]; message?: string };
      if (msg.type === "reset") {
        held.current = [];
        setHeldN(0);
        setEntries([]);
        setError(null);
        setStatus("live");
      } else if (msg.type === "entries" && msg.entries) {
        if (pausedRef.current) {
          held.current = [...held.current, ...msg.entries].slice(-MAX);
          setHeldN(held.current.length);
        } else setEntries((prev) => [...prev, ...msg.entries!].slice(-MAX));
      } else if (msg.type === "error") setError(msg.message ?? "journalctl failed");
      else if (msg.type === "ended") setStatus("ended");
    };
    sock.onclose = () => setStatus("closed");
    return () => sock.close();
  }, []);

  useEffect(() => {
    const send = () => {
      const sock = ws.current;
      if (sock?.readyState === WebSocket.OPEN)
        sock.send(JSON.stringify({ type: "filter", lines: 300, ...filter }));
    };
    const t = window.setTimeout(() => {
      if (ws.current?.readyState === WebSocket.CONNECTING)
        ws.current.addEventListener("open", send, { once: true });
      else send();
    }, 350);
    return () => window.clearTimeout(t);
  }, [filter]);

  useEffect(() => {
    if (!paused && held.current.length) {
      const more = held.current;
      held.current = [];
      setHeldN(0);
      setEntries((prev) => [...prev, ...more].slice(-MAX));
    }
  }, [paused]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  const set = (patch: Partial<LogFilter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-2.5">
        <div
          role="radiogroup"
          aria-label="Journal"
          className="inline-flex rounded-full bg-[var(--hairline)] p-0.5"
        >
          {(
            [
              [false, "System"],
              [true, "Mine"],
            ] as const
          ).map(([user, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={filter.user === user}
              onClick={() => set({ user })}
              className={`h-7 rounded-full px-3 text-sm ${filter.user === user ? "bg-[var(--surface-strong)] text-ink shadow-sm" : "text-ink-2"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={filter.unit}
          onChange={(e) => set({ unit: e.target.value.trim() })}
          placeholder="Unit (e.g. sshd)"
          aria-label="Unit"
          spellCheck={false}
          className={`${field} num w-56`}
        />
        <select
          value={filter.priority}
          onChange={(e) => set({ priority: e.target.value })}
          aria-label="Level"
          className={field}
        >
          {PRIOS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          value={filter.since}
          onChange={(e) => set({ since: e.target.value })}
          aria-label="Since"
          className={field}
        >
          {SINCE.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input
          value={filter.grep}
          onChange={(e) => set({ grep: e.target.value })}
          placeholder="Search (regex)"
          aria-label="Search"
          spellCheck={false}
          className={`${field} min-w-[160px] flex-1`}
        />
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? "Resume" : "Pause"}
          title={paused ? "Resume" : "Pause"}
          className={`grid size-8 place-items-center rounded-full transition hover:bg-[var(--hairline)] ${paused ? "bg-accent-soft text-accent-ink" : "text-ink-2"}`}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </button>
        <button
          type="button"
          onClick={() => setEntries([])}
          aria-label="Clear"
          title="Clear"
          className="grid size-8 place-items-center rounded-full text-ink-2 transition hover:bg-[var(--hairline)]"
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {error && (
        <p role="alert" className="border-b border-hairline px-3 py-1.5 text-xs text-danger-ink">
          {error}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="num relative min-h-0 flex-1 overflow-auto px-3 py-2 text-[12.5px] leading-[1.55]"
      >
        {entries.length === 0 ? (
          <p className="py-10 text-center font-sans text-sm text-ink-2">
            {status === "connecting"
              ? "Connecting…"
              : status === "closed"
                ? "Disconnected. Reopen Logs to reconnect."
                : "No entries yet."}
          </p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${PRIO_STYLE[e.prio] ?? "text-ink"}`}>
              <span className="text-ink-2">{new Date(e.t * 1000).toLocaleTimeString()} </span>
              <span className="text-accent-ink">{e.ident || e.unit}</span>
              {e.pid && <span className="text-ink-2">[{e.pid}]</span>}
              <span className="text-ink-2">: </span>
              {e.msg}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-hairline px-3 py-1.5 text-xs text-ink-2">
        <span
          className={`size-1.5 rounded-full ${status === "live" && !paused ? "bg-success" : "bg-[var(--hairline-strong)]"}`}
        />
        {paused ? `Paused${heldN ? ` · ${heldN} new` : ""}` : status === "live" ? "Live" : status}
        <span className="num">{entries.length} lines</span>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-[var(--hairline)] hover:text-ink"
          >
            <ArrowDownToLine className="size-3.5" /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
