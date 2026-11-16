import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bookmark,
  Clock3,
  Download,
  FileDown,
  Folder,
  HardDrive,
  House,
  Image,
  Monitor,
  Music,
  RotateCcw,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { withReauth } from "../../components/Reauth";
import { spring } from "../../components/motion";
import { toastError, useToasts } from "../../lib/toasts";
import { bytes } from "../../widgets/format";
import { fsApi, kindOf, type Entry, type TrashItem } from "./api";
import { cancelUpload, useUploads } from "./uploads";
import { EntryIcon, KIND_LABEL } from "./views";

const Preview = lazy(() => import("../../previews").then((m) => ({ default: m.Preview })));

// ── recent files (per device) ───────────────────────────────────────────────

const RECENT_KEY = "kiln.files.recent";
export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function pushRecent(path: string): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([path, ...recentFiles().filter((p) => p !== path)].slice(0, 15)),
    );
  } catch {
    /* ignore */
  }
}

// ── sidebar ────────────────────────────────────────────────────────────────

const PLACES: [string, string, typeof House][] = [
  ["Home", "~", House],
  ["Desktop", "~/Desktop", Monitor],
  ["Documents", "~/Documents", Folder],
  ["Downloads", "~/Downloads", Download],
  ["Pictures", "~/Pictures", Image],
  ["Music", "~/Music", Music],
  ["Videos", "~/Videos", Video],
];

interface SidebarProps {
  current: string;
  mode: "browse" | "trash" | "search";
  onGo: (path: string) => void;
  onTrash: () => void;
  onReveal: (path: string) => void;
  onDropOn: (e: DragEvent, dir: string) => void;
}

function SideItem({
  label,
  icon: Icon,
  active,
  onClick,
  onDrop,
  children,
}: {
  label: string;
  icon: typeof House;
  active: boolean;
  onClick: () => void;
  onDrop?: (e: DragEvent) => void;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={onDrop ? (e) => (e.preventDefault(), setOver(true)) : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop ? (e) => (setOver(false), onDrop(e)) : undefined}
      className={`group flex items-center rounded-full ${active ? "bg-accent-soft text-accent-ink" : over ? "bg-[var(--hairline-strong)]" : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-left text-sm"
        aria-current={active}
      >
        <Icon className="size-4 shrink-0" strokeWidth={1.5} />
        <span className="truncate">{label}</span>
      </button>
      {children}
    </div>
  );
}

export function Sidebar({ current, mode, onGo, onTrash, onReveal, onDropOn }: SidebarProps) {
  const qc = useQueryClient();
  const { data: bm } = useQuery({ queryKey: ["fs", "bookmarks"], queryFn: fsApi.bookmarks });
  const { data: usage } = useQuery({
    queryKey: ["fs", "usage"],
    queryFn: fsApi.usage,
    refetchInterval: 60_000,
  });
  const recent = recentFiles();
  const removeBookmark = async (path: string) => {
    try {
      const r = await fsApi.setBookmarks((bm?.bookmarks ?? []).filter((b) => b.path !== path));
      qc.setQueryData(["fs", "bookmarks"], r);
    } catch (err) {
      toastError("Couldn't update bookmarks", err);
    }
  };
  const pct = usage ? (usage.used / usage.total) * 100 : 0;
  return (
    <nav
      className="flex h-full w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--hairline)] p-2.5"
      aria-label="Places"
    >
      <div className="flex flex-col gap-0.5">
        {PLACES.map(([label, path, icon]) => (
          <SideItem
            key={path}
            label={label}
            icon={icon}
            active={mode === "browse" && current === path}
            onClick={() => onGo(path)}
            onDrop={(e) => onDropOn(e, path)}
          />
        ))}
        <SideItem label="Trash" icon={Trash2} active={mode === "trash"} onClick={onTrash} />
      </div>
      {!!bm?.bookmarks.length && (
        <div className="flex flex-col gap-0.5">
          <p className="px-3 text-xs font-medium text-ink-2">Bookmarks</p>
          {bm.bookmarks.map((b) => (
            <SideItem
              key={b.path}
              label={b.name}
              icon={Bookmark}
              active={mode === "browse" && current === b.path}
              onClick={() => onGo(b.path)}
              onDrop={(e) => onDropOn(e, b.path)}
            >
              <button
                type="button"
                onClick={() => void removeBookmark(b.path)}
                className="mr-1 hidden size-6 place-items-center rounded-full group-hover:grid"
                aria-label={`Remove bookmark ${b.name}`}
              >
                <X className="size-3.5" strokeWidth={1.5} />
              </button>
            </SideItem>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="px-3 text-xs font-medium text-ink-2">Recent</p>
          {recent.slice(0, 6).map((p) => (
            <SideItem
              key={p}
              label={p.split("/").pop() ?? p}
              icon={Clock3}
              active={false}
              onClick={() => onReveal(p)}
            />
          ))}
        </div>
      )}
      {usage && (
        <div className="mt-auto px-3 pb-1">
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <HardDrive className="size-3.5" strokeWidth={1.5} />
            <span className="num">
              {bytes(usage.free)} free · {usage.fs_type}
            </span>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]"
            title={`${bytes(usage.used)} of ${bytes(usage.total)} used`}
          >
            <div
              className={`h-full rounded-full ${pct > 90 ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </nav>
  );
}

// ── properties ─────────────────────────────────────────────────────────────

const WHO = ["Owner", "Group", "Others"] as const;
const BITS = [
  ["Read", 4],
  ["Write", 2],
  ["Run", 1],
] as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="num min-w-0 truncate text-right text-ink">{children}</span>
    </div>
  );
}

export function Properties({ entry, onChanged }: { entry: Entry; onChanged: () => void }) {
  const { data: stat } = useQuery({
    queryKey: ["fs", "stat", entry.path, entry.mtime],
    queryFn: () => fsApi.stat(entry.path),
  });
  const [mode, setMode] = useState(entry.mode);
  const [hash, setHash] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);
  useEffect(() => {
    setMode(entry.mode);
    setHash(null);
  }, [entry.path, entry.mode]);
  const digits = mode.padStart(3, "0").slice(-3).split("").map(Number);
  const toggle = (who: number, bit: number) => {
    const d = [...digits];
    d[who] = (d[who] ?? 0) ^ bit;
    setMode(d.join(""));
  };
  const applyMode = async () => {
    try {
      await fsApi.chmod(entry.path, mode);
      useToasts.getState().push({ tone: "success", title: `Permissions set to ${mode}` });
      onChanged();
    } catch (err) {
      toastError("Couldn't change permissions", err);
    }
  };
  const checksum = async () => {
    setHashing(true);
    try {
      setHash((await fsApi.checksum(entry.path, "sha256")).hex);
    } catch (err) {
      toastError("Couldn't compute the checksum", err);
    } finally {
      setHashing(false);
    }
  };
  const kind = kindOf(entry);
  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="heading-display text-lg break-all text-ink">{entry.name}</p>
      <Row label="Kind">
        {KIND_LABEL[kind]}
        {entry.mime ? ` · ${entry.mime}` : ""}
      </Row>
      {kind === "dir" ? (
        <Row label="Items">{stat?.items ?? "—"}</Row>
      ) : (
        <Row label="Size">{bytes(entry.size)}</Row>
      )}
      <Row label="Modified">{new Date(entry.mtime * 1000).toLocaleString()}</Row>
      {stat && <Row label="Accessed">{new Date(stat.atime * 1000).toLocaleString()}</Row>}
      <Row label="Owner">
        {entry.owner}:{entry.group}
      </Row>
      {entry.target !== null && entry.type === "symlink" && (
        <Row label="Points to">{entry.target ?? "outside your home"}</Row>
      )}
      <Row label="Location">{entry.path}</Row>
      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-2">Permissions</span>
          <span className="num text-sm text-ink">{mode}</span>
        </div>
        <div className="mt-1.5 grid grid-cols-[auto_repeat(3,1fr)] gap-x-2 gap-y-1 text-xs">
          <span />
          {BITS.map(([b]) => (
            <span key={b} className="text-center text-ink-2">
              {b}
            </span>
          ))}
          {WHO.map((w, wi) => (
            <div key={w} className="contents">
              <span className="text-ink-2">{w}</span>
              {BITS.map(([b, bit]) => (
                <label key={b} className="grid place-items-center">
                  <input
                    type="checkbox"
                    checked={((digits[wi] ?? 0) & bit) !== 0}
                    onChange={() => toggle(wi, bit)}
                    aria-label={`${w} can ${b.toLowerCase()}`}
                    className="accent-[var(--accent)]"
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
        {mode !== entry.mode && (
          <button
            type="button"
            onClick={() => void applyMode()}
            className="mt-2 rounded-full bg-accent-fill px-3 py-1 text-xs text-on-accent"
          >
            Apply {mode}
          </button>
        )}
      </div>
      {kind !== "dir" && (
        <div className="mt-2">
          {hash ? (
            <p
              className="num rounded-[10px] bg-[var(--hairline)] p-2 text-[11px] break-all text-ink"
              title="SHA-256"
            >
              {hash}
            </p>
          ) : (
            <button
              type="button"
              disabled={hashing}
              onClick={() => void checksum()}
              className="rounded-full px-3 py-1 text-xs text-ink-2 ring-1 ring-[var(--hairline-strong)] hover:text-ink"
            >
              {hashing ? "Computing…" : "SHA-256 checksum"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PreviewPane({ entry, onChanged }: { entry: Entry | null; onChanged: () => void }) {
  if (!entry)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-2">
        Select a file to preview it.
      </div>
    );
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {kindOf(entry) !== "dir" && !entry.denied && (
        <div className="h-56 shrink-0 overflow-hidden border-b border-[var(--hairline)]">
          <Suspense
            fallback={<div className="grid h-full place-items-center text-sm text-ink-2">Loading…</div>}
          >
            <Preview entry={entry} compact />
          </Suspense>
        </div>
      )}
      <Properties entry={entry} onChanged={onChanged} />
    </div>
  );
}

export function Viewer({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <motion.div
      className="absolute inset-0 z-30 flex flex-col bg-[var(--surface-solid)]"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-2">
        <EntryIcon entry={entry} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.path}</span>
        <button
          type="button"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
          aria-label="Close preview"
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={<div className="grid h-full place-items-center text-sm text-ink-2">Loading…</div>}
        >
          <Preview entry={entry} />
        </Suspense>
      </div>
    </motion.div>
  );
}

// ── trash ──────────────────────────────────────────────────────────────────

export function TrashView() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["fs", "trash"], queryFn: fsApi.trashList });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const refresh = () => void qc.invalidateQueries({ queryKey: ["fs"] });
  const restore = async (ids: string[]) => {
    try {
      const r = await fsApi.restore(ids);
      useToasts.getState().push({
        tone: "success",
        title: `Restored ${r.restored.length} item${r.restored.length === 1 ? "" : "s"}`,
      });
      setSel(new Set());
      refresh();
    } catch (err) {
      toastError("Couldn't restore", err);
    }
  };
  const forget = async (ids: string[] | null) => {
    try {
      await withReauth(
        ids ? "Deleting from the trash can't be undone." : "Emptying the trash can't be undone.",
        () => (ids ? fsApi.trashDelete(ids) : fsApi.emptyTrash()),
      );
      setSel(new Set());
      refresh();
    } catch (err) {
      toastError("Couldn't delete", err);
    }
  };
  const items: TrashItem[] = data?.items ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-2">
        <h3 className="heading-display flex-1 text-xl text-ink">Trash</h3>
        {sel.size > 0 && (
          <>
            <button
              type="button"
              onClick={() => void restore([...sel])}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--hairline)] px-3 py-1.5 text-sm text-ink"
            >
              <RotateCcw className="size-3.5" strokeWidth={1.5} /> Restore
            </button>
            <button
              type="button"
              onClick={() => void forget([...sel])}
              className="rounded-full px-3 py-1.5 text-sm text-danger-ink hover:bg-[var(--hairline)]"
            >
              Delete forever
            </button>
          </>
        )}
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => void forget(null)}
            className="rounded-full px-3 py-1.5 text-sm text-danger-ink hover:bg-[var(--hairline)]"
          >
            Empty trash
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading && <p className="p-4 text-sm text-ink-2">Loading…</p>}
        {error && <p className="p-4 text-sm text-danger-ink">Couldn't read the trash.</p>}
        {!isLoading && !items.length && (
          <p className="p-6 text-center text-sm text-ink-2">The trash is empty.</p>
        )}
        {items.map((t) => {
          const on = sel.has(t.id);
          return (
            <div
              key={t.id}
              onClick={() =>
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
              onDoubleClick={() => void restore([t.id])}
              className={`grid cursor-default grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_80px] items-center gap-3 rounded-[10px] px-3 py-1.5 text-sm ${on ? "bg-accent-soft" : "hover:bg-[var(--hairline)]"}`}
              aria-selected={on}
              role="row"
            >
              <span className="flex min-w-0 items-center gap-2">
                <EntryIcon entry={{ name: t.name, type: t.type, mime: null, link_type: null } as Entry} />
                <span className="truncate text-ink">{t.name}</span>
              </span>
              <span className="num truncate text-xs text-ink-2">{t.original_path}</span>
              <span className="num text-xs text-ink-2">
                {new Date(t.deleted_at * 1000).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              <span className="num text-right text-xs text-ink-2">
                {t.type === "dir" ? "—" : bytes(t.size)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── uploads tray ───────────────────────────────────────────────────────────

export function UploadTray() {
  const items = useUploads((s) => s.items);
  const clear = useUploads((s) => s.clearFinished);
  if (!items.length) return null;
  const active = items.filter((u) => u.state === "uploading" || u.state === "queued").length;
  return (
    <div className="window absolute right-3 bottom-10 z-20 w-72 rounded-[16px] p-3">
      <div className="mb-2 flex items-center gap-2">
        <FileDown className="size-4 text-accent-ink" strokeWidth={1.5} />
        <span className="flex-1 text-sm text-ink">{active ? `Uploading ${active}…` : "Uploads"}</span>
        {!active && (
          <button type="button" onClick={clear} className="text-xs text-ink-2 hover:text-ink">
            Clear
          </button>
        )}
      </div>
      <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {items.map((u) => (
          <li key={u.key}>
            <div className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
              <span className={`num ${u.state === "error" ? "text-danger-ink" : "text-ink-2"}`}>
                {u.state === "done"
                  ? "Done"
                  : u.state === "error"
                    ? "Failed"
                    : u.state === "cancelled"
                      ? "Cancelled"
                      : `${Math.floor((u.sent / Math.max(1, u.size)) * 100)}%`}
              </span>
              {(u.state === "uploading" || u.state === "queued") && (
                <button
                  type="button"
                  onClick={() => cancelUpload(u.key)}
                  aria-label={`Cancel ${u.name}`}
                  className="text-ink-2 hover:text-ink"
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--hairline)]">
              <div
                className={`h-full rounded-full ${u.state === "error" ? "bg-danger" : "bg-accent"}`}
                style={{ width: `${(u.sent / Math.max(1, u.size)) * 100}%`, transition: "width .3s" }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── small dialogs ──────────────────────────────────────────────────────────

export interface DialogSpec {
  title: string;
  message?: string;
  input?: string; // present → prompt
  confirm: string;
  danger?: boolean;
  resolve: (value: string | null) => void;
}

export function Dialog({ spec, onClose }: { spec: DialogSpec | null; onClose: () => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (spec) {
      setV(spec.input ?? "");
      requestAnimationFrame(() => ref.current?.select());
    }
  }, [spec]);
  const done = (value: string | null) => {
    spec?.resolve(value);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    done(spec?.input !== undefined ? v.trim() || null : "ok");
  };
  return (
    <AnimatePresence>
      {spec && (
        <motion.div
          className="absolute inset-0 z-40 grid place-items-center bg-[color-mix(in_srgb,var(--bg)_35%,transparent)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => done(null)}
        >
          <motion.form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && done(null)}
            className="window flex w-[min(380px,calc(100%-32px))] flex-col gap-3 rounded-[24px] p-5"
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            transition={spring}
            role="dialog"
            aria-label={spec.title}
          >
            <h3 className="heading-display text-xl text-ink">{spec.title}</h3>
            {spec.message && <p className="text-sm text-ink-2">{spec.message}</p>}
            {spec.input !== undefined && (
              <input
                ref={ref}
                autoFocus
                value={v}
                onChange={(e) => setV(e.target.value)}
                aria-label={spec.title}
                className="h-10 rounded-full border border-[var(--hairline-strong)] bg-transparent px-4 text-sm text-ink outline-none focus:border-accent"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => done(null)}
                className="rounded-full px-4 py-1.5 text-sm text-ink-2 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                autoFocus={spec.input === undefined}
                className={`rounded-full px-4 py-1.5 text-sm ${spec.danger ? "text-danger-ink ring-1 ring-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]" : "bg-accent-fill text-on-accent"}`}
              >
                {spec.confirm}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
