import { AlertTriangle, FileCode2, GitCompareArrows, Plus, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fsApi } from "../files/api";
import { ApiError } from "../../lib/api";
import { useUI } from "../../lib/store";
import { withReauth } from "../../components/Reauth";
import { toastError } from "../../lib/toasts";
import { ensureThemes, languageFor, monaco, EDITOR_OPTIONS, monacoTheme } from "./monaco";
import { useEditorQueue } from "./pending";

type View = "edit" | "diff" | "compare";

interface Tab {
  path: string;
  name: string;
  status: "loading" | "ready" | "error";
  error?: string;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
}

interface Meta {
  saved: string;
  mtime: string;
  eol: "lf" | "crlf";
}

interface Compare {
  disk: string;
  mtime: string;
}

const baseName = (p: string) => p.split("/").pop() || p;

function loadErrorMessage(e: unknown): string {
  const err = e as { code?: string; status?: number; message?: string };
  if (err.code === "binary" || err.status === 415) return "This file isn't text.";
  if (err.code === "too_large" || err.status === 413) return "This file is too large to open in the editor.";
  if (err.code === "denied")
    return "This file is protected. Opening it needs your password, which isn't supported here yet.";
  if (err.code === "not_found") return "This file no longer exists.";
  return err.message || "Couldn't open this file.";
}

function Pill({
  children,
  onClick,
  tone = "plain",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "plain" | "accent";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
        tone === "accent"
          ? "bg-accent-fill text-on-accent hover:brightness-105"
          : "bg-[var(--hairline)] text-ink hover:brightness-95"
      }`}
    >
      {children}
    </button>
  );
}

export default function EditorApp() {
  const mode = useUI((s) => s.mode);
  const queue = useEditorQueue((s) => s.queue);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<View>("edit");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [eol, setEol] = useState<"LF" | "CRLF">("LF");
  const [openBar, setOpenBar] = useState(false);
  const [pathInput, setPathInput] = useState("");

  const editorHost = useRef<HTMLDivElement>(null);
  const diffHost = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const meta = useRef(new Map<string, Meta>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const lastActive = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => undefined);
  const openRef = useRef<() => void>(() => undefined);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const patchTab = useCallback((path: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  }, []);

  // --- create the editors once ---
  useEffect(() => {
    ensureThemes();
    const theme = monacoTheme(useUI.getState().mode);
    const ed = monaco.editor.create(editorHost.current!, { ...EDITOR_OPTIONS, theme, model: null });
    const de = monaco.editor.createDiffEditor(diffHost.current!, {
      ...EDITOR_OPTIONS,
      theme,
      renderSideBySide: true,
      originalEditable: false,
    });
    editor.current = ed;
    diffEditor.current = de;
    const save = () => saveRef.current();
    const open = () => openRef.current();
    for (const e of [ed, de.getModifiedEditor()]) {
      e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, open);
    }
    const sub = ed.onDidChangeCursorPosition((e) =>
      setPos({ line: e.position.lineNumber, col: e.position.column }),
    );
    const modelMap = models.current;
    return () => {
      sub.dispose();
      de.setModel(null);
      ed.dispose();
      de.dispose();
      for (const m of modelMap.values()) m.dispose();
      modelMap.clear();
    };
  }, []);

  useEffect(() => {
    ensureThemes();
    monaco.editor.setTheme(monacoTheme(mode));
  }, [mode]);

  // --- opening files ---
  const openPath = useCallback(
    (raw: string) => {
      const path = raw.trim();
      if (!path) return;
      setActive(path);
      setView("edit");
      if (models.current.has(path)) return;
      setTabs((ts) =>
        ts.some((t) => t.path === path)
          ? ts
          : [
              ...ts,
              { path, name: baseName(path), status: "loading", dirty: false, saving: false, conflict: false },
            ],
      );
      withReauth(`${path} is protected. Confirm your password to open it.`, () => fsApi.readText(path))
        .then((f) => {
          if (models.current.has(path)) return;
          const model = monaco.editor.createModel(f.content, languageFor(baseName(path)));
          model.setEOL(
            f.eol === "crlf" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
          );
          meta.current.set(path, { saved: model.getValue(), mtime: f.mtime_ns, eol: f.eol });
          model.onDidChangeContent(() => {
            const m = meta.current.get(path);
            if (m) patchTab(path, { dirty: model.getValue() !== m.saved });
          });
          models.current.set(path, model);
          patchTab(path, { status: "ready", error: undefined });
        })
        .catch((e: unknown) => {
          const code = (e as { code?: string }).code;
          if (!["binary", "too_large", "denied", "not_found"].includes(code ?? ""))
            toastError("Couldn't open file", e);
          patchTab(path, { status: "error", error: loadErrorMessage(e) });
        });
    },
    [patchTab],
  );

  useEffect(() => {
    if (!queue.length) return;
    const paths = useEditorQueue.getState().take();
    for (const p of paths) openPath(p);
  }, [queue, openPath]);

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const activeModel = active ? models.current.get(active) : undefined;
  const ready = activeTab?.status === "ready" && !!activeModel;

  // --- bind models to the right editor ---
  useEffect(() => {
    const ed = editor.current;
    const de = diffEditor.current;
    if (!ed || !de) return;
    if (lastActive.current && lastActive.current !== active) {
      viewStates.current.set(lastActive.current, ed.saveViewState());
    }
    lastActive.current = active;
    const model = active ? models.current.get(active) : undefined;
    if (!model || !ready) {
      ed.setModel(null);
      de.setModel(null);
      return;
    }
    if (view === "edit") {
      de.setModel(null);
      ed.setModel(model);
      const vs = viewStates.current.get(active!);
      if (vs) ed.restoreViewState(vs);
      setEol(model.getEOL() === "\r\n" ? "CRLF" : "LF");
      const p = ed.getPosition();
      if (p) setPos({ line: p.lineNumber, col: p.column });
      ed.focus();
      return;
    }
    const m = meta.current.get(active!);
    const originalText = view === "compare" ? (compare?.disk ?? "") : (m?.saved ?? "");
    const original = monaco.editor.createModel(originalText, model.getLanguageId());
    original.setEOL(
      model.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
    );
    de.setModel({ original, modified: model });
    return () => {
      de.setModel(null);
      original.dispose();
    };
  }, [active, view, ready, compare, tabs.length]);

  // --- saving & conflicts ---
  const writeWith = useCallback(
    async (path: string, mtime: string) => {
      const model = models.current.get(path);
      if (!model) return;
      const content = model.getValue();
      patchTab(path, { saving: true });
      try {
        const r = await fsApi.writeText(path, content, mtime);
        meta.current.set(path, { ...meta.current.get(path)!, saved: content, mtime: r.mtime_ns });
        patchTab(path, { saving: false, dirty: model.getValue() !== content, conflict: false });
        return true;
      } catch (e) {
        patchTab(path, { saving: false });
        if (e instanceof ApiError && e.code === "conflict") patchTab(path, { conflict: true });
        else toastError("Couldn't save file", e);
        return false;
      }
    },
    [patchTab],
  );

  const save = useCallback(() => {
    if (!active) return;
    const m = meta.current.get(active);
    if (m && models.current.has(active)) void writeWith(active, m.mtime);
  }, [active, writeWith]);
  saveRef.current = save;
  openRef.current = () => {
    setOpenBar(true);
    setTimeout(() => pathInputRef.current?.focus(), 0);
  };

  const fetchDisk = useCallback(async (path: string) => {
    try {
      return await fsApi.readText(path);
    } catch (e) {
      toastError("Couldn't read the file from disk", e);
      return null;
    }
  }, []);

  const overwrite = async () => {
    if (!active) return;
    const disk = await fetchDisk(active);
    if (!disk) return;
    const ok = await writeWith(active, disk.mtime_ns);
    if (ok) {
      setCompare(null);
      setView("edit");
    }
  };

  const useDisk = async () => {
    if (!active) return;
    const disk =
      compare && view === "compare"
        ? { content: compare.disk, mtime_ns: compare.mtime }
        : await fetchDisk(active);
    if (!disk) return;
    const model = models.current.get(active);
    if (!model) return;
    model.setValue(disk.content);
    meta.current.set(active, { ...meta.current.get(active)!, saved: model.getValue(), mtime: disk.mtime_ns });
    patchTab(active, { conflict: false, dirty: false });
    setCompare(null);
    setView("edit");
  };

  const startCompare = async () => {
    if (!active) return;
    const disk = await fetchDisk(active);
    if (!disk) return;
    setCompare({ disk: disk.content, mtime: disk.mtime_ns });
    setView("compare");
  };

  // --- closing tabs ---
  const closeTab = (path: string) => {
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    models.current.get(path)?.dispose();
    models.current.delete(path);
    meta.current.delete(path);
    viewStates.current.delete(path);
    setTabs(next);
    setClosing(null);
    if (active === path) {
      setActive(next[Math.min(idx, next.length - 1)]?.path ?? null);
      setView("edit");
      setCompare(null);
    }
  };
  const requestClose = (t: Tab) => (t.dirty ? setClosing(t.path) : closeTab(t.path));
  const closingTab = tabs.find((t) => t.path === closing);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openRef.current();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveRef.current();
    }
  };

  const submitPath = (e: React.FormEvent) => {
    e.preventDefault();
    let p = pathInput.trim();
    if (!p) return;
    if (!p.startsWith("~") && !p.startsWith("/")) p = `~/${p}`;
    openPath(p);
    setPathInput("");
    setOpenBar(false);
  };

  const pathForm = (
    <form onSubmit={submitPath} className="flex items-center gap-2">
      <input
        ref={pathInputRef}
        value={pathInput}
        onChange={(e) => setPathInput(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpenBar(false)}
        placeholder="~/notes/todo.md"
        spellCheck={false}
        aria-label="File path"
        className="num w-64 max-w-full rounded-full bg-[var(--hairline)] px-4 py-1.5 text-sm text-ink outline-none placeholder:text-ink-2 focus:ring-2 focus:ring-[var(--accent)]"
      />
      <Pill onClick={() => submitPath({ preventDefault: () => undefined } as React.FormEvent)} tone="accent">
        Open
      </Pill>
    </form>
  );

  const empty = tabs.length === 0;
  const dirty = !!activeTab?.dirty;

  return (
    <div ref={root} onKeyDown={onKeyDown} className="flex h-full w-full flex-col text-ink">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.path}
              role="tab"
              aria-selected={t.path === active}
              title={t.path}
              onClick={() => {
                setActive(t.path);
                setView("edit");
                setCompare(null);
              }}
              className={`group flex max-w-48 shrink-0 cursor-pointer items-center gap-2 rounded-full py-1 pl-3 pr-1.5 text-sm transition ${
                t.path === active ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-[var(--hairline)]"
              }`}
            >
              <span className="truncate">{t.name}</span>
              {t.dirty && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-[var(--accent)]"
                  aria-label="Unsaved changes"
                />
              )}
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(t);
                }}
                className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-[var(--hairline-strong)]"
              >
                <X className="size-3.5" strokeWidth={1.5} />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-label="Open a file (Ctrl+O)"
            title="Open a file (Ctrl+O)"
            onClick={() => openRef.current()}
            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
          >
            <Plus className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        {ready && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-pressed={view === "diff"}
              onClick={() => {
                setCompare(null);
                setView(view === "diff" ? "edit" : "diff");
              }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                view === "diff"
                  ? "bg-accent-soft text-accent-ink"
                  : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
              }`}
            >
              <GitCompareArrows className="size-4" strokeWidth={1.5} />
              Diff
            </button>
            <Pill onClick={save} tone="accent" disabled={!dirty || activeTab?.saving}>
              <span className="flex items-center gap-1.5">
                <Save className="size-3.5" strokeWidth={1.5} />
                {activeTab?.saving ? "Saving…" : "Save"}
              </span>
            </Pill>
          </div>
        )}
      </div>

      {openBar && !empty && <div className="shrink-0 px-3 pt-2">{pathForm}</div>}

      {/* Inline prompts */}
      {closingTab && (
        <div className="mx-3 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-[16px] bg-accent-soft px-4 py-2 text-sm text-accent-ink">
          <span className="mr-auto">Close {closingTab.name} with unsaved changes?</span>
          <Pill
            tone="accent"
            onClick={async () => {
              const m = meta.current.get(closingTab.path);
              if (m && (await writeWith(closingTab.path, m.mtime))) closeTab(closingTab.path);
            }}
          >
            Save and close
          </Pill>
          <Pill onClick={() => closeTab(closingTab.path)}>Discard</Pill>
          <Pill onClick={() => setClosing(null)}>Keep editing</Pill>
        </div>
      )}
      {activeTab?.conflict && (
        <div className="mx-3 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-[16px] bg-accent-soft px-4 py-2 text-sm text-accent-ink">
          <AlertTriangle className="size-4 shrink-0" strokeWidth={1.5} />
          <span className="mr-auto">Changed on disk since you opened it</span>
          {view !== "compare" && <Pill onClick={startCompare}>Compare</Pill>}
          <Pill onClick={overwrite}>Overwrite</Pill>
          <Pill onClick={useDisk}>Reload from disk</Pill>
        </div>
      )}
      {view === "compare" && (
        <div className="mx-3 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-[16px] bg-[var(--hairline)] px-4 py-2 text-sm">
          <span className="mr-auto text-ink-2">Left: on disk. Right: your version.</span>
          <Pill tone="accent" onClick={overwrite}>
            Keep mine (overwrite)
          </Pill>
          <Pill onClick={useDisk}>Use disk version</Pill>
          <Pill
            onClick={() => {
              setCompare(null);
              setView("edit");
            }}
          >
            Back
          </Pill>
        </div>
      )}

      {/* Editor area */}
      <div className="relative mt-2 min-h-0 flex-1">
        <div
          ref={editorHost}
          className={`absolute inset-0 ${ready && view === "edit" ? "" : "invisible pointer-events-none [&_*]:!pointer-events-none"}`}
          aria-hidden={!ready}
        />
        <div
          ref={diffHost}
          className={`absolute inset-0 ${ready && view !== "edit" ? "" : "invisible pointer-events-none [&_*]:!pointer-events-none"}`}
          aria-hidden={!ready}
        />
        {empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="grid size-14 place-items-center rounded-[16px] bg-accent-soft text-accent-ink">
              <FileCode2 className="size-7" strokeWidth={1.5} />
            </div>
            <h2 className="heading-display text-xl">Nothing open yet</h2>
            <p className="text-sm text-ink-2">Open a file from Files or press Ctrl+O</p>
            {pathForm}
          </div>
        )}
        {activeTab?.status === "loading" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-ink-2">
            Opening {activeTab.name}…
          </div>
        )}
        {activeTab?.status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-6 text-[var(--danger-ink)]" strokeWidth={1.5} />
            <p className="max-w-sm text-sm text-ink-2">{activeTab.error}</p>
            <p className="num text-xs text-ink-2">{activeTab.path}</p>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="num flex h-7 shrink-0 items-center gap-4 px-4 text-xs text-ink-2">
        {ready ? (
          <>
            <span>
              Ln {pos.line}, Col {pos.col}
            </span>
            <span>{activeModel?.getLanguageId()}</span>
            <span>{eol}</span>
            <span className="ml-auto">{dirty ? "Unsaved" : "Saved"}</span>
          </>
        ) : (
          <span className="ml-auto">Ctrl+S saves · Ctrl+O opens</span>
        )}
      </div>
    </div>
  );
}
