import { useQuery } from "@tanstack/react-query";
import {
  Box,
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderLock,
  FolderSymlink,
  Lock,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { bytes } from "../../widgets/format";
import { fsApi, kindOf, rawUrl, type Entry, type Kind } from "./api";

const KIND_ICON: Record<Kind, LucideIcon> = {
  dir: Folder,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  markdown: FileText,
  code: FileCode2,
  text: FileText,
  model: Box,
  archive: FileArchive,
  other: File,
};

export const KIND_LABEL: Record<Kind, string> = {
  dir: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  markdown: "Markdown",
  code: "Code",
  text: "Text",
  model: "3D model",
  archive: "Archive",
  other: "File",
};

export function EntryIcon({ entry, className = "size-[18px]" }: { entry: Entry; className?: string }) {
  const kind = kindOf(entry);
  let Icon = KIND_ICON[kind];
  if (entry.denied) Icon = kind === "dir" ? FolderLock : Lock;
  else if (entry.type === "symlink" && kind === "dir") Icon = FolderSymlink;
  const tone = entry.denied ? "text-warn-ink" : kind === "dir" ? "text-accent-ink" : "text-ink-2";
  return <Icon className={`${className} shrink-0 ${tone}`} strokeWidth={1.5} />;
}

export function when(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
      });
}

export type SortKey = "name" | "size" | "mtime" | "kind";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

export function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  const dirFirst = (a: Entry, b: Entry) => Number(kindOf(b) === "dir") - Number(kindOf(a) === "dir");
  const by: Record<SortKey, (a: Entry, b: Entry) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    size: (a, b) => a.size - b.size,
    mtime: (a, b) => a.mtime - b.mtime,
    kind: (a, b) => KIND_LABEL[kindOf(a)].localeCompare(KIND_LABEL[kindOf(b)]),
  };
  return [...entries].sort((a, b) => dirFirst(a, b) || by[sort.key](a, b) * sort.dir || by.name(a, b));
}

/** Shared per-item interaction props built by FilesApp. */
export interface ItemHandlers {
  selected: Set<string>;
  renaming: string | null;
  onClick: (e: MouseEvent, entry: Entry, index: number) => void;
  onOpen: (entry: Entry) => void;
  onContext: (e: MouseEvent, entry: Entry | null) => void;
  onRename: (entry: Entry, name: string | null) => void;
  onDragStart: (e: DragEvent, entry: Entry) => void;
  onDropOn: (e: DragEvent, dir: string) => void;
}

function RenameInput({ entry, onDone }: { entry: Entry; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(entry.name);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.type !== "dir" ? entry.name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(v.trim() && v !== entry.name ? v.trim() : null);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(v.trim() && v !== entry.name ? v.trim() : null)}
      aria-label={`Rename ${entry.name}`}
      className="min-w-0 flex-1 rounded-[8px] border border-accent bg-[var(--surface-solid)] px-1.5 py-0.5 text-sm text-ink outline-none"
    />
  );
}

const isDir = (e: Entry) => kindOf(e) === "dir";

function dropProps(entry: Entry, h: ItemHandlers, setOver: (v: boolean) => void) {
  if (!isDir(entry) || entry.denied) return {};
  return {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      setOver(false);
      h.onDropOn(e, entry.path);
    },
  };
}

function ListRow({ entry, index, h }: { entry: Entry; index: number; h: ItemHandlers }) {
  const [over, setOver] = useState(false);
  const sel = h.selected.has(entry.path);
  return (
    <div
      role="row"
      aria-selected={sel}
      data-path={entry.path}
      draggable={h.renaming !== entry.path}
      onDragStart={(e) => h.onDragStart(e, entry)}
      {...dropProps(entry, h, setOver)}
      onClick={(e) => h.onClick(e, entry, index)}
      onDoubleClick={() => h.onOpen(entry)}
      onContextMenu={(e) => h.onContext(e, entry)}
      className={`grid cursor-default grid-cols-[minmax(0,1fr)_88px_120px] items-center gap-3 rounded-[10px] px-3 py-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_88px_140px_96px] ${
        sel ? "bg-accent-soft" : over ? "bg-[var(--hairline-strong)]" : "hover:bg-[var(--hairline)]"
      } ${entry.hidden ? "opacity-70" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <EntryIcon entry={entry} />
        {h.renaming === entry.path ? (
          <RenameInput entry={entry} onDone={(n) => h.onRename(entry, n)} />
        ) : (
          <span className="truncate text-ink">{entry.name}</span>
        )}
      </span>
      <span className="num text-right text-xs text-ink-2">{isDir(entry) ? "—" : bytes(entry.size)}</span>
      <span className="num text-xs text-ink-2">{when(entry.mtime)}</span>
      <span className="hidden truncate text-xs text-ink-2 sm:block">{KIND_LABEL[kindOf(entry)]}</span>
    </div>
  );
}

export function ListView({
  entries,
  h,
  sort,
  onSort,
}: {
  entries: Entry[];
  h: ItemHandlers;
  sort: Sort;
  onSort: (k: SortKey) => void;
}) {
  const head = (k: SortKey, label: string, cls = "") => (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`flex items-center gap-1 text-xs text-ink-2 hover:text-ink ${cls}`}
      aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      {label}
      {sort.key === k && <span aria-hidden>{sort.dir === 1 ? "↑" : "↓"}</span>}
    </button>
  );
  return (
    <div role="grid" aria-label="Files" className="flex flex-col gap-0.5 px-2 pb-6">
      <div className="sticky top-0 z-[1] grid grid-cols-[minmax(0,1fr)_88px_120px] gap-3 bg-[var(--surface-strong)] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_88px_140px_96px]">
        {head("name", "Name")}
        {head("size", "Size", "justify-end")}
        {head("mtime", "Modified")}
        <span className="hidden sm:block">{head("kind", "Kind")}</span>
      </div>
      {entries.map((e, i) => (
        <ListRow key={e.path} entry={e} index={i} h={h} />
      ))}
    </div>
  );
}

function GridTile({ entry, index, h }: { entry: Entry; index: number; h: ItemHandlers }) {
  const [over, setOver] = useState(false);
  const [broken, setBroken] = useState(false);
  const sel = h.selected.has(entry.path);
  const kind = kindOf(entry);
  const thumb = kind === "image" && !entry.denied && entry.size < 25 * 1024 * 1024 && !broken;
  return (
    <div
      role="gridcell"
      aria-selected={sel}
      data-path={entry.path}
      draggable={h.renaming !== entry.path}
      onDragStart={(e) => h.onDragStart(e, entry)}
      {...dropProps(entry, h, setOver)}
      onClick={(e) => h.onClick(e, entry, index)}
      onDoubleClick={() => h.onOpen(entry)}
      onContextMenu={(e) => h.onContext(e, entry)}
      className={`flex cursor-default flex-col items-center gap-2 rounded-[16px] p-2.5 text-center ${
        sel ? "bg-accent-soft" : over ? "bg-[var(--hairline-strong)]" : "hover:bg-[var(--hairline)]"
      } ${entry.hidden ? "opacity-70" : ""}`}
    >
      <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-[12px] bg-[var(--hairline)]">
        {thumb ? (
          <img
            src={rawUrl(entry.path)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <EntryIcon entry={entry} className="size-10" />
        )}
      </div>
      {h.renaming === entry.path ? (
        <RenameInput entry={entry} onDone={(n) => h.onRename(entry, n)} />
      ) : (
        <span className="line-clamp-2 w-full text-xs break-all text-ink">{entry.name}</span>
      )}
    </div>
  );
}

export function GridView({ entries, h }: { entries: Entry[]; h: ItemHandlers }) {
  return (
    <div
      role="grid"
      aria-label="Files"
      className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5 p-3 pb-6"
    >
      {entries.map((e, i) => (
        <GridTile key={e.path} entry={e} index={i} h={h} />
      ))}
    </div>
  );
}

/** Ancestors of `path` from home, e.g. "~/a/b" → ["~", "~/a", "~/a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.replace(/^~\/?/, "").split("/").filter(Boolean);
  return ["~", ...parts.map((_, i) => `~/${parts.slice(0, i + 1).join("/")}`)];
}

function Column({
  path,
  child,
  hidden,
  sort,
  h,
  entriesOverride,
}: {
  path: string;
  child: string | null;
  hidden: boolean;
  sort: Sort;
  h: ItemHandlers;
  entriesOverride?: Entry[];
}) {
  const { data } = useQuery({
    queryKey: ["fs", "list", path, hidden],
    queryFn: () => fsApi.list(path, hidden),
    enabled: !entriesOverride,
  });
  const entries = entriesOverride ?? sortEntries(data?.entries ?? [], sort);
  return (
    <div
      className="flex h-full w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--hairline)] p-1.5"
      aria-label={path}
    >
      {entries.map((e, i) => {
        const sel = h.selected.has(e.path) || e.path === child;
        return (
          <div
            key={e.path}
            data-path={e.path}
            draggable
            onDragStart={(ev) => h.onDragStart(ev, e)}
            onClick={(ev) => h.onClick(ev, e, i)}
            onDoubleClick={() => h.onOpen(e)}
            onContextMenu={(ev) => h.onContext(ev, e)}
            className={`flex cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-sm ${sel ? "bg-accent-soft" : "hover:bg-[var(--hairline)]"}`}
          >
            <EntryIcon entry={e} className="size-4" />
            <span className="min-w-0 flex-1 truncate text-ink">{e.name}</span>
            {kindOf(e) === "dir" && <ChevronRight className="size-3.5 text-ink-2" strokeWidth={1.5} />}
          </div>
        );
      })}
    </div>
  );
}

/** Miller columns: one column per ancestor of the current folder. */
export function ColumnView({
  path,
  entries,
  hidden,
  sort,
  h,
  extra,
}: {
  path: string;
  entries: Entry[];
  hidden: boolean;
  sort: Sort;
  h: ItemHandlers;
  extra?: ReactNode;
}) {
  const chain = ancestors(path);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" });
  }, [path]);
  return (
    <div ref={scroller} className="flex h-full overflow-x-auto">
      {chain.slice(0, -1).map((p, i) => (
        <Column key={p} path={p} child={chain[i + 1] ?? null} hidden={hidden} sort={sort} h={h} />
      ))}
      <Column path={path} child={null} hidden={hidden} sort={sort} h={h} entriesOverride={entries} />
      {extra}
    </div>
  );
}
