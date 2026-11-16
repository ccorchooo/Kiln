import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Eye,
  EyeOff,
  FilePlus2,
  FolderPlus,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Star,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { withReauth } from "../../components/Reauth";
import { spring } from "../../components/motion";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/store";
import { toastError, useToasts } from "../../lib/toasts";
import { useIsMobile } from "../../shell/hooks";
import type { AppProps } from "../../shell/apps";
import { useWM } from "../../shell/wm";
import { bytes } from "../../widgets/format";
import { openInEditor } from "../editor/pending";
import { openTerminalAt } from "../terminal/open";
import { fsApi, kindOf, rawUrl, zipUrl, type Entry } from "./api";
import {
  Dialog,
  PreviewPane,
  pushRecent,
  Sidebar,
  TrashView,
  UploadTray,
  Viewer,
  type DialogSpec,
} from "./panels";
import { usePendingPath } from "./pending";
import { uploadFiles } from "./uploads";
import {
  ancestors,
  ColumnView,
  GridView,
  ListView,
  sortEntries,
  type ItemHandlers,
  type Sort,
  type SortKey,
} from "./views";
import { watchDir } from "./watch";

// Cut/copy clipboard shared by every Files window.
const useFileClipboard = create<{ op: "copy" | "cut" | null; paths: string[] }>(() => ({
  op: null,
  paths: [],
}));

type View = "list" | "grid" | "columns";
interface Prefs {
  view: View;
  hidden: boolean;
  sort: Sort;
  sidebar: boolean;
  preview: boolean;
}
const PREFS_KEY = "kiln.files.prefs";
function loadPrefs(): Prefs {
  const d: Prefs = {
    view: "list",
    hidden: false,
    sort: { key: "name", dir: 1 },
    sidebar: true,
    preview: true,
  };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return d;
  }
}

interface Tab {
  id: string;
  path: string;
  back: string[];
  fwd: string[];
}
const newTab = (path = "~"): Tab => ({ id: Math.random().toString(36).slice(2, 9), path, back: [], fwd: [] });
const parentOf = (p: string) => (p === "~" ? null : p.slice(0, p.lastIndexOf("/")) || "~");
const join = (dir: string, name: string) => (dir === "~" ? `~/${name}` : `${dir}/${name}`);

interface ContentMatch {
  path: string;
  name: string;
  line: number;
  text: string;
}

function Tool({
  label,
  onClick,
  active,
  disabled,
  className = "",
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-full transition disabled:opacity-40 ${className} ${active ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

export default function FilesApp({ windowId }: AppProps) {
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((s) => {
      const n = { ...s, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [ti, setTi] = useState(0);
  const tab = tabs[Math.min(ti, tabs.length - 1)]!;
  const [mode, setMode] = useState<"browse" | "trash" | "search">("browse");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number>(-1);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null);
  const [viewer, setViewer] = useState<Entry | null>(null);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"name" | "content">("name");
  const [results, setResults] = useState<{
    entries: Entry[];
    lines: ContentMatch[];
    done: boolean;
    truncated: boolean;
  }>({ entries: [], lines: [], done: true, truncated: false });
  const [dropping, setDropping] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const searchAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clip = useFileClipboard();

  const ask = (opts: Omit<DialogSpec, "resolve">) =>
    new Promise<string | null>((resolve) => setDialog({ ...opts, resolve }));

  // Listing (prompts for the password when the folder is protected).
  const listing = useQuery({
    queryKey: ["fs", "list", tab.path, prefs.hidden],
    queryFn: () =>
      withReauth(`${tab.path} is protected. Confirm your password to open it.`, () =>
        fsApi.list(tab.path, prefs.hidden),
      ),
    enabled: mode !== "trash",
    retry: false,
  });
  const entries = useMemo(
    () => sortEntries(listing.data?.entries ?? [], prefs.sort),
    [listing.data, prefs.sort],
  );
  const shown = mode === "search" ? results.entries : entries;
  const selectedEntries = shown.filter((e) => selected.has(e.path));
  const single = selectedEntries.length === 1 ? selectedEntries[0]! : null;
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["fs"] }), [qc]);

  useEffect(() => watchDir(tab.path, qc), [tab.path, qc]);

  useEffect(() => {
    if (listing.error instanceof ApiError && listing.error.status !== 0)
      toastError(`Couldn't open ${tab.path}`, listing.error);
  }, [listing.error, tab.path]);

  // Hand-offs ("open in Files" from the terminal, Ember…).
  const pending = usePendingPath((s) => s.path);
  useEffect(() => {
    const p = usePendingPath.getState().take();
    if (p) void reveal(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const go = (path: string, push = true) => {
    setMode("browse");
    setSelected(new Set());
    setRenaming(null);
    setTabs((ts) =>
      ts.map((t, i) =>
        i === ti
          ? {
              ...t,
              path,
              back: push && t.path !== path ? [...t.back, t.path] : t.back,
              fwd: push ? [] : t.fwd,
            }
          : t,
      ),
    );
  };
  const back = () => {
    const prev = tab.back.at(-1);
    if (!prev) return;
    setMode("browse");
    setSelected(new Set());
    setTabs((ts) =>
      ts.map((t, i) =>
        i === ti ? { ...t, path: prev, back: t.back.slice(0, -1), fwd: [t.path, ...t.fwd] } : t,
      ),
    );
  };
  const forward = () => {
    const next = tab.fwd[0];
    if (!next) return;
    setMode("browse");
    setSelected(new Set());
    setTabs((ts) =>
      ts.map((t, i) => (i === ti ? { ...t, path: next, back: [...t.back, t.path], fwd: t.fwd.slice(1) } : t)),
    );
  };
  const up = () => {
    const p = parentOf(tab.path);
    if (p) go(p);
  };

  /** Go to a file's folder and select it; or into a folder. */
  async function reveal(path: string) {
    try {
      const st = await fsApi.stat(path);
      if (kindOf(st) === "dir") go(st.path);
      else {
        go(parentOf(st.path) ?? "~");
        setTimeout(() => setSelected(new Set([st.path])), 50);
      }
    } catch (err) {
      toastError(`Couldn't open ${path}`, err);
    }
  }

  const openEntry = (e: Entry) => {
    const kind = kindOf(e);
    if (kind === "dir") return go(e.path);
    pushRecent(e.path);
    if (kind === "code" || kind === "text") return openInEditor(e.path);
    setViewer(e);
  };

  // ── mutations ────────────────────────────────────────────────────────────
  const run = async <T,>(title: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn();
      refresh();
      return r;
    } catch (err) {
      toastError(title, err);
      return undefined;
    }
  };

  const createNew = async (kind: "dir" | "file") => {
    const base = kind === "dir" ? "New folder" : "Untitled.txt";
    const names = new Set(entries.map((e) => e.name));
    let name = base;
    for (let n = 2; names.has(name); n++) name = kind === "dir" ? `${base} ${n}` : `Untitled ${n}.txt`;
    const created = await run(`Couldn't create ${name}`, () =>
      kind === "dir" ? fsApi.mkdir(join(tab.path, name)) : fsApi.touch(join(tab.path, name)),
    );
    if (created) {
      setSelected(new Set([created.path]));
      setRenaming(created.path);
    }
  };

  const rename = async (entry: Entry, name: string | null) => {
    setRenaming(null);
    if (!name) return;
    const r = await run(`Couldn't rename ${entry.name}`, () => fsApi.rename(entry.path, name));
    if (r) setSelected(new Set([r.path]));
  };

  const trash = async (paths: string[]) => {
    if (!paths.length) return;
    const r = await run("Couldn't move to the trash", () => fsApi.trash(paths));
    if (r) {
      setSelected(new Set());
      useToasts.getState().push({
        tone: "info",
        title: `Moved ${paths.length} item${paths.length > 1 ? "s" : ""} to the trash`,
        message: "Restore them from Trash in the sidebar.",
      });
    }
  };

  const deleteForever = async (paths: string[]) => {
    if (!paths.length) return;
    const ok = await ask({
      title: `Delete ${paths.length === 1 ? (paths[0]!.split("/").pop() ?? "") : `${paths.length} items`} forever?`,
      message: "This skips the trash and can't be undone.",
      confirm: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    await run("Couldn't delete", () =>
      withReauth("Deleting permanently can't be undone.", () => fsApi.remove(paths)),
    );
    setSelected(new Set());
  };

  const paste = async (dest = tab.path) => {
    const { op, paths } = useFileClipboard.getState();
    if (!op || !paths.length) return;
    if (op === "cut") {
      await run("Couldn't move", () => fsApi.move(paths, dest));
      useFileClipboard.setState({ op: null, paths: [] });
    } else await run("Couldn't copy", () => fsApi.copy(paths, dest));
  };

  const compress = async (paths: string[]) => {
    const def = paths.length === 1 ? `${paths[0]!.split("/").pop()}.zip` : "Archive.zip";
    const name = await ask({
      title: "Compress",
      message: "Name ends in .zip or .tar.gz",
      input: def,
      confirm: "Compress",
    });
    if (name) await run("Couldn't compress", () => fsApi.compress(paths, join(tab.path, name)));
  };

  const bookmark = async (path: string) => {
    try {
      const cur = (await fsApi.bookmarks()).bookmarks;
      if (cur.some((b) => b.path === path)) return;
      const r = await fsApi.setBookmarks([...cur, { name: path.split("/").pop() || "Home", path }]);
      qc.setQueryData(["fs", "bookmarks"], r);
      useToasts.getState().push({ tone: "success", title: "Bookmarked", message: path });
    } catch (err) {
      toastError("Couldn't add the bookmark", err);
    }
  };

  const download = (paths: string[], entriesFor: Entry[]) => {
    const a = document.createElement("a");
    a.href = paths.length === 1 && kindOf(entriesFor[0]!) !== "dir" ? rawUrl(paths[0]!, true) : zipUrl(paths);
    a.rel = "noopener";
    a.click();
  };

  // ── search (NDJSON stream) ───────────────────────────────────────────────
  const runSearch = async (q: string) => {
    searchAbort.current?.abort();
    if (!q.trim()) {
      setMode("browse");
      return;
    }
    const ctrl = new AbortController();
    searchAbort.current = ctrl;
    setMode("search");
    setSelected(new Set());
    setResults({ entries: [], lines: [], done: false, truncated: false });
    try {
      const res = await fetch(
        `/api/fs/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(tab.path)}&mode=${searchMode}&hidden=${prefs.hidden ? 1 : 0}`,
        { signal: ctrl.signal, credentials: "same-origin" },
      );
      if (!res.ok || !res.body) throw new ApiError(res.status, "search_failed", "Search failed");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        const ents: Entry[] = [];
        const hits: ContentMatch[] = [];
        let fin: { truncated?: boolean } | null = null;
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l) as { type: string; truncated?: boolean };
          if (m.type === "done") fin = m;
          else if (searchMode === "name") {
            // The stream's own "type" is "match"; the entry's type arrives as "kind".
            const { kind, ...rest } = m as unknown as Entry & { kind: Entry["type"] };
            ents.push({ ...rest, type: kind });
          } else hits.push(m as unknown as ContentMatch);
        }
        setResults((r) => ({
          entries: [...r.entries, ...ents],
          lines: [...r.lines, ...hits],
          done: !!fin || r.done,
          truncated: fin?.truncated ?? r.truncated,
        }));
      }
      setResults((r) => ({ ...r, done: true }));
    } catch (err) {
      if ((err as Error).name !== "AbortError") toastError("Search failed", err);
    }
  };

  // ── drag & drop ──────────────────────────────────────────────────────────
  const onDragStart = (e: DragEvent, entry: Entry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path];
    e.dataTransfer.setData("application/x-kiln-paths", JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  const onDropOn = (e: DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const internal = e.dataTransfer.getData("application/x-kiln-paths");
    if (internal) {
      const paths = (JSON.parse(internal) as string[]).filter((p) => p !== dir && parentOf(p) !== dir);
      if (!paths.length) return;
      void (e.ctrlKey
        ? run("Couldn't copy", () => fsApi.copy(paths, dir))
        : run("Couldn't move", () => fsApi.move(paths, dir)));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) void uploadFiles(files, dir, refresh);
  };

  // ── selection & keyboard ─────────────────────────────────────────────────
  const onClick = (e: MouseEvent, entry: Entry, index: number) => {
    mainRef.current?.focus();
    if (mobile && !e.ctrlKey && !e.shiftKey) {
      if (kindOf(entry) === "dir") return go(entry.path);
      setSelected(new Set([entry.path]));
      return openEntry(entry);
    }
    setSelected((s) => {
      if (e.shiftKey && anchor.current >= 0) {
        const [a, b] = [anchor.current, index].sort((x, y) => x - y);
        return new Set(shown.slice(a, b! + 1).map((x) => x.path));
      }
      anchor.current = index;
      if (e.ctrlKey || e.metaKey) {
        const n = new Set(s);
        if (n.has(entry.path)) n.delete(entry.path);
        else n.add(entry.path);
        return n;
      }
      return new Set([entry.path]);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || (e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.ctrlKey || e.metaKey;
    const idx = shown.findIndex((x) => x.path === [...selected].at(-1));
    const pick = (i: number) => {
      const t = shown[Math.max(0, Math.min(shown.length - 1, i))];
      if (!t) return;
      setSelected((s) => (e.shiftKey ? new Set([...s, t.path]) : new Set([t.path])));
      anchor.current = shown.indexOf(t);
      mainRef.current
        ?.querySelector(`[data-path="${CSS.escape(t.path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    const step =
      prefs.view === "grid" ? Math.max(1, Math.floor((mainRef.current?.clientWidth ?? 600) / 118)) : 1;
    const handled = (() => {
      if (e.key === "ArrowDown") return (pick(idx + step), true);
      if (e.key === "ArrowUp") return (pick(idx < 0 ? 0 : idx - step), true);
      if (prefs.view === "grid" && e.key === "ArrowRight") return (pick(idx + 1), true);
      if (prefs.view === "grid" && e.key === "ArrowLeft") return (pick(idx - 1), true);
      if (e.key === "Enter" && single) return (openEntry(single), true);
      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) return (up(), true);
      if (e.altKey && e.key === "ArrowLeft") return (back(), true);
      if (e.altKey && e.key === "ArrowRight") return (forward(), true);
      if (e.key === "Delete" && e.shiftKey) return (void deleteForever([...selected]), true);
      if (e.key === "Delete") return (void trash([...selected]), true);
      if (e.key === "F2" && single) return (setRenaming(single.path), true);
      if (e.key === " " && single) return (setViewer(single), true);
      if (mod && e.key === "a") return (setSelected(new Set(shown.map((x) => x.path))), true);
      if (mod && e.key === "c" && selected.size)
        return (useFileClipboard.setState({ op: "copy", paths: [...selected] }), true);
      if (mod && e.key === "x" && selected.size)
        return (useFileClipboard.setState({ op: "cut", paths: [...selected] }), true);
      if (mod && e.key === "v") return (void paste(), true);
      if (mod && e.key === "f") return (searchRef.current?.focus(), true);
      if (mod && e.key === "l") return (setPathDraft(tab.path), setEditingPath(true), true);
      if (e.key === "Escape") return (setSelected(new Set()), true);
      return false;
    })();
    if (handled) e.preventDefault();
  };

  const handlers: ItemHandlers = {
    selected,
    renaming,
    onClick,
    onOpen: openEntry,
    onContext: (e, entry) => {
      e.preventDefault();
      e.stopPropagation();
      if (entry && !selected.has(entry.path)) setSelected(new Set([entry.path]));
      setMenu({ x: e.clientX, y: e.clientY, entry });
    },
    onRename: (entry, name) => void rename(entry, name),
    onDragStart,
    onDropOn,
  };

  // ── context menu ─────────────────────────────────────────────────────────
  const menuItems = (entry: Entry | null): ([string, () => void, boolean?] | null)[] => {
    const assistant = useAuth.getState().assistantName;
    const paths = entry ? (selected.has(entry.path) ? [...selected] : [entry.path]) : [];
    const ents = shown.filter((x) => paths.includes(x.path));
    const dir = entry && kindOf(entry) === "dir" ? entry.path : tab.path;
    if (!entry)
      return [
        ["New folder", () => void createNew("dir")],
        ["New file", () => void createNew("file")],
        ["Upload files…", () => fileInput.current?.click()],
        clip.op
          ? [`Paste ${clip.paths.length} item${clip.paths.length > 1 ? "s" : ""}`, () => void paste()]
          : null,
        null,
        ["Open in terminal here", () => openTerminalAt(tab.path)],
        ["Bookmark this folder", () => void bookmark(tab.path)],
        [
          `Ask ${assistant} about this folder`,
          () => useWM.getState().ask(`Tell me about the folder ${tab.path}.`),
        ],
      ];
    const kind = kindOf(entry);
    return [
      ["Open", () => openEntry(entry)],
      kind !== "dir" ? ["Open in Editor", () => openInEditor(entry.path)] : null,
      kind !== "dir" ? ["Preview", () => setViewer(entry)] : null,
      ["Open in terminal here", () => openTerminalAt(dir)],
      [
        `Ask ${assistant} about ${paths.length > 1 ? "these" : "this"}`,
        () =>
          useWM
            .getState()
            .ask(`Tell me about ${paths.length > 1 ? "these files" : "this file"}:\n${paths.join("\n")}`),
      ],
      null,
      ["Cut", () => useFileClipboard.setState({ op: "cut", paths })],
      ["Copy", () => useFileClipboard.setState({ op: "copy", paths })],
      clip.op && kind === "dir" ? ["Paste into folder", () => void paste(entry.path)] : null,
      ["Copy path", () => void navigator.clipboard?.writeText(paths.join("\n"))],
      ["Rename", () => setRenaming(entry.path), paths.length > 1],
      null,
      kind === "archive"
        ? ["Extract here", () => void run("Couldn't extract", () => fsApi.extract(entry.path))]
        : null,
      ["Compress…", () => void compress(paths)],
      ["Download", () => download(paths, ents)],
      kind === "dir" ? ["Bookmark", () => void bookmark(entry.path)] : null,
      null,
      ["Move to trash", () => void trash(paths)],
      ["Delete forever…", () => void deleteForever(paths)],
    ];
  };

  // ── layout ───────────────────────────────────────────────────────────────
  const crumbs = ancestors(tab.path);
  const body = (() => {
    if (mode === "trash") return <TrashView />;
    if (mode === "search" && searchMode === "content")
      return (
        <ul className="flex flex-col gap-0.5 p-2">
          {results.lines.map((m, i) => (
            <li key={`${m.path}:${m.line}:${i}`}>
              <button
                type="button"
                onClick={() => openInEditor(m.path)}
                className="w-full rounded-[10px] px-3 py-1.5 text-left hover:bg-[var(--hairline)]"
              >
                <span className="num text-xs text-ink-2">
                  {m.path}:{m.line}
                </span>
                <span className="num block truncate text-sm text-ink">{m.text}</span>
              </button>
            </li>
          ))}
          {results.done && !results.lines.length && (
            <li className="p-6 text-center text-sm text-ink-2">No matches.</li>
          )}
        </ul>
      );
    if (listing.isLoading) return <p className="p-6 text-sm text-ink-2">Loading…</p>;
    if (mode === "browse" && !entries.length)
      return (
        <p className="p-10 text-center text-sm text-ink-2">
          This folder is empty. Drop files here to upload.
        </p>
      );
    if (prefs.view === "grid" || mobile)
      return mobile ? (
        <ListView entries={shown} h={handlers} sort={prefs.sort} onSort={setSort} />
      ) : (
        <GridView entries={shown} h={handlers} />
      );
    if (prefs.view === "columns" && mode === "browse")
      return (
        <ColumnView path={tab.path} entries={entries} hidden={prefs.hidden} sort={prefs.sort} h={handlers} />
      );
    return <ListView entries={shown} h={handlers} sort={prefs.sort} onSort={setSort} />;
  })();

  function setSort(k: SortKey) {
    setPrefs({ sort: { key: k, dir: prefs.sort.key === k ? (-prefs.sort.dir as 1 | -1) : 1 } });
  }

  const totalSel = selectedEntries.reduce((n, e) => n + (kindOf(e) === "dir" ? 0 : e.size), 0);
  const showSidebar = mobile ? sidebarOpen : prefs.sidebar;

  return (
    <div className="@container relative flex h-full flex-col" data-files-window={windowId}>
      {tabs.length > 1 && (
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto px-2 pt-1.5">
          {tabs.map((t, i) => (
            <div
              key={t.id}
              className={`group flex h-7 shrink-0 items-center gap-1 rounded-full pr-1 pl-3 text-xs ${i === ti ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-[var(--hairline)]"}`}
            >
              <button type="button" onClick={() => setTi(i)} className="max-w-40 truncate">
                {t.path === "~" ? "Home" : t.path.split("/").pop()}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTabs((ts) => ts.filter((_, j) => j !== i));
                  setTi((x) => Math.max(0, x > i ? x - 1 : Math.min(x, tabs.length - 2)));
                }}
                className="grid size-5 place-items-center rounded-full hover:bg-[var(--hairline)]"
                aria-label="Close tab"
              >
                <X className="size-3" strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--hairline)] px-2 py-1.5">
        <Tool
          label="Sidebar"
          onClick={() => (mobile ? setSidebarOpen(!sidebarOpen) : setPrefs({ sidebar: !prefs.sidebar }))}
          active={showSidebar}
        >
          <PanelLeft className="size-4" strokeWidth={1.5} />
        </Tool>
        <Tool label="Back (Alt+←)" onClick={back} disabled={!tab.back.length}>
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </Tool>
        {!mobile && (
          <Tool label="Forward (Alt+→)" onClick={forward} disabled={!tab.fwd.length}>
            <ArrowRight className="size-4" strokeWidth={1.5} />
          </Tool>
        )}
        <Tool label="Up (Backspace)" onClick={up} disabled={tab.path === "~" || mode === "trash"}>
          <ArrowUp className="size-4" strokeWidth={1.5} />
        </Tool>
        <div className="min-w-0 flex-1">
          {editingPath ? (
            <input
              autoFocus
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingPath(false);
                  void reveal(pathDraft.trim() || "~");
                }
                if (e.key === "Escape") setEditingPath(false);
              }}
              aria-label="Location"
              className="num h-8 w-full rounded-full border border-accent bg-transparent px-3 text-sm text-ink outline-none"
            />
          ) : (
            <nav
              aria-label="Location"
              className="no-scrollbar flex items-center overflow-x-auto"
              onDoubleClick={() => {
                setPathDraft(tab.path);
                setEditingPath(true);
              }}
            >
              {mode === "trash" ? (
                <span className="px-2 text-sm text-ink">Trash</span>
              ) : (
                crumbs.map((c, i) => (
                  <span key={c} className="flex shrink-0 items-center">
                    {i > 0 && <span className="px-0.5 text-ink-2">/</span>}
                    <button
                      type="button"
                      onClick={() => go(c)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDropOn(e, c)}
                      className={`rounded-full px-2 py-1 text-sm ${i === crumbs.length - 1 ? "text-ink" : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"}`}
                    >
                      {i === 0 ? "Home" : c.split("/").pop()}
                    </button>
                  </span>
                ))
              )}
            </nav>
          )}
        </div>
        <div
          className={`flex h-8 items-center gap-1 rounded-full border border-[var(--hairline-strong)] pr-1 pl-2.5 ${mobile ? "w-32" : "w-40 @4xl:w-56"}`}
        >
          <Search className="size-3.5 shrink-0 text-ink-2" strokeWidth={1.5} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch(query);
              if (e.key === "Escape") {
                setQuery("");
                searchAbort.current?.abort();
                setMode("browse");
              }
            }}
            placeholder={searchMode === "name" ? "Find by name" : "Find in files"}
            aria-label="Search in this folder"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
          {!mobile && (
            <button
              type="button"
              onClick={() => setSearchMode(searchMode === "name" ? "content" : "name")}
              className="rounded-full px-2 py-0.5 text-[11px] text-ink-2 hover:bg-[var(--hairline)]"
              title="Search names or contents"
            >
              {searchMode === "name" ? "Name" : "Text"}
            </button>
          )}
        </div>
        {!mobile && (
          <>
            <Tool
              className="hidden @4xl:grid"
              label="List"
              active={prefs.view === "list"}
              onClick={() => setPrefs({ view: "list" })}
            >
              <List className="size-4" strokeWidth={1.5} />
            </Tool>
            <Tool
              className="hidden @4xl:grid"
              label="Grid"
              active={prefs.view === "grid"}
              onClick={() => setPrefs({ view: "grid" })}
            >
              <LayoutGrid className="size-4" strokeWidth={1.5} />
            </Tool>
            <Tool
              className="hidden @4xl:grid"
              label="Columns"
              active={prefs.view === "columns"}
              onClick={() => setPrefs({ view: "columns" })}
            >
              <Columns3 className="size-4" strokeWidth={1.5} />
            </Tool>
          </>
        )}
        <Tool
          label={prefs.hidden ? "Hide hidden files" : "Show hidden files"}
          active={prefs.hidden}
          onClick={() => setPrefs({ hidden: !prefs.hidden })}
        >
          {prefs.hidden ? (
            <Eye className="size-4" strokeWidth={1.5} />
          ) : (
            <EyeOff className="size-4" strokeWidth={1.5} />
          )}
        </Tool>
        {!mobile && (
          <>
            <Tool className="hidden @4xl:grid" label="New folder" onClick={() => void createNew("dir")}>
              <FolderPlus className="size-4" strokeWidth={1.5} />
            </Tool>
            <Tool className="hidden @4xl:grid" label="New file" onClick={() => void createNew("file")}>
              <FilePlus2 className="size-4" strokeWidth={1.5} />
            </Tool>
            <Tool
              className="hidden @4xl:grid"
              label="Bookmark this folder"
              onClick={() => void bookmark(tab.path)}
            >
              <Star className="size-4" strokeWidth={1.5} />
            </Tool>
            <Tool
              className="hidden @4xl:grid"
              label="New tab"
              onClick={() => {
                setTabs((ts) => [...ts, newTab(tab.path)]);
                setTi(tabs.length);
              }}
            >
              <Plus className="size-4" strokeWidth={1.5} />
            </Tool>
          </>
        )}
        <Tool label="Upload" onClick={() => fileInput.current?.click()}>
          <Upload className="size-4" strokeWidth={1.5} />
        </Tool>
        {!mobile && (
          <Tool
            className="hidden @4xl:grid"
            label="Preview pane"
            active={prefs.preview}
            onClick={() => setPrefs({ preview: !prefs.preview })}
          >
            <PanelRight className="size-4" strokeWidth={1.5} />
          </Tool>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void uploadFiles(files, tab.path, refresh);
          }}
        />
      </div>

      <div className="relative flex min-h-0 flex-1">
        {showSidebar && (
          <div
            className={
              mobile ? "absolute inset-y-0 left-0 z-20 bg-[var(--surface-solid)] shadow-xl" : "contents"
            }
          >
            <Sidebar
              current={tab.path}
              mode={mode}
              onGo={(p) => {
                go(p);
                setSidebarOpen(false);
              }}
              onTrash={() => {
                setMode("trash");
                setSidebarOpen(false);
              }}
              onReveal={(p) => void reveal(p)}
              onDropOn={onDropOn}
            />
          </div>
        )}
        <div
          ref={mainRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
          onContextMenu={(e) => mode === "browse" && handlers.onContext(e, null)}
          onDragOver={(e) => {
            if (mode !== "browse") return;
            e.preventDefault();
            if (e.dataTransfer.types.includes("Files")) setDropping(true);
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
          onDrop={(e) => mode === "browse" && onDropOn(e, tab.path)}
          className={`relative min-w-0 flex-1 overflow-auto outline-none ${dropping ? "ring-2 ring-accent ring-inset" : ""}`}
          aria-label="Folder contents"
        >
          {mode === "search" && (
            <div className="flex items-center gap-2 px-4 pt-3 text-sm text-ink-2">
              {results.done
                ? `${searchMode === "name" ? results.entries.length : results.lines.length} result${(searchMode === "name" ? results.entries.length : results.lines.length) === 1 ? "" : "s"}${results.truncated ? " (more not shown)" : ""}`
                : "Searching…"}
              <span>in {tab.path}</span>
              <button
                type="button"
                onClick={() => {
                  setMode("browse");
                  setQuery("");
                  searchAbort.current?.abort();
                }}
                className="ml-auto rounded-full px-2 py-0.5 hover:bg-[var(--hairline)]"
              >
                Clear
              </button>
            </div>
          )}
          {body}
        </div>
        {prefs.preview && !mobile && mode !== "trash" && (
          <aside
            className="hidden w-72 shrink-0 border-l border-[var(--hairline)] @4xl:block"
            aria-label="Details"
          >
            <PreviewPane entry={single} onChanged={refresh} />
          </aside>
        )}
        <UploadTray />
        <AnimatePresence>
          {viewer && <Viewer entry={viewer} onClose={() => setViewer(null)} />}
        </AnimatePresence>
        <Dialog spec={dialog} onClose={() => setDialog(null)} />
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--hairline)] px-4 py-1.5 text-xs text-ink-2">
        <span className="num">
          {mode === "browse" ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : ""}
        </span>
        {selected.size > 0 && (
          <span className="num">
            {selected.size} selected{totalSel ? ` · ${bytes(totalSel)}` : ""}
          </span>
        )}
        {clip.op && (
          <span>
            {clip.paths.length} item{clip.paths.length > 1 ? "s" : ""} to{" "}
            {clip.op === "cut" ? "move" : "copy"} · Ctrl+V to paste
          </span>
        )}
      </div>

      {createPortal(
        <AnimatePresence>
          {menu && (
            <>
              <div
                className="fixed inset-0 z-[70]"
                onClick={() => setMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu(null);
                }}
              />
              <motion.div
                role="menu"
                className="window fixed z-[71] w-60 rounded-[16px] p-1.5"
                style={{
                  left: Math.min(menu.x, window.innerWidth - 248),
                  top: Math.min(menu.y, window.innerHeight - 440),
                }}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={spring}
              >
                {menuItems(menu.entry).map((item, i) =>
                  item === null ? (
                    <div key={`sep${i}`} className="mx-2 my-1 h-px bg-[var(--hairline)]" />
                  ) : (
                    <button
                      key={item[0]}
                      role="menuitem"
                      type="button"
                      disabled={item[2]}
                      onClick={() => {
                        setMenu(null);
                        item[1]();
                      }}
                      className={`w-full rounded-[10px] px-3 py-1.5 text-left text-sm disabled:opacity-40 ${item[0].startsWith("Delete") ? "text-danger-ink" : "text-ink"} hover:bg-[var(--hairline)]`}
                    >
                      {item[0]}
                    </button>
                  ),
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
