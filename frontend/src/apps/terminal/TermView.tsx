/**
 * One terminal pane: an xterm.js instance attached to a server PTY over /ws/terminal/{id}.
 * Each (re)attach starts with the server's replay buffer, so the screen is reset first.
 */
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useUI } from "../../lib/store";
import { terminalTheme } from "../../theme/terminal";
import { openInFiles } from "../files/pending";
import { FONT_STACK, useTermPrefs } from "./prefs";

export type PaneStatus = "connecting" | "live" | "exited" | "gone" | "elsewhere" | "offline";

export interface TermHandle {
  send: (text: string) => void;
  focus: () => void;
  selection: () => string;
  tail: (lines: number) => string;
  search: (q: string, dir: "next" | "prev") => boolean;
  clearSearch: () => void;
  copy: () => void;
  paste: () => void;
  clear: () => void;
  takeOver: () => void;
  setModifiers: (m: { ctrl: boolean; alt: boolean }) => void;
}

interface Props {
  termId: string;
  focused: boolean;
  onFocus: () => void;
  onTitle: (title: string) => void;
  onStatus: (s: PaneStatus, exitCode?: number | null) => void;
  onContextMenu: (x: number, y: number) => void;
  onModifierUsed: () => void;
  onSearchShortcut: () => void;
}

const enc = new TextEncoder();
const HOME_PATH = /(?:~|\/home\/[\w.-]+)(?:\/[\w.@%+=:,-]+)+\/?/g;

export const TermView = forwardRef<TermHandle, Props>(function TermView(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const mods = useRef({ ctrl: false, alt: false });
  const cb = useRef(props);
  cb.current = props;
  const [attachKey, setAttachKey] = useState(0);
  const prefs = useTermPrefs();
  const mode = useUI((s) => s.mode);
  const themeId = useUI((s) => s.themeId);

  const sendBytes = (data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(data));
  };

  // Create the terminal once per pane.
  useEffect(() => {
    const el = host.current!;
    const p = useTermPrefs.getState();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: FONT_STACK[p.font],
      fontSize: p.fontSize,
      lineHeight: 1.15,
      scrollback: 10000,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      theme: terminalTheme(useUI.getState().themeId, useUI.getState().mode),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
    searchRef.current = search;
    term.open(el);

    const disposables: IDisposable[] = [];
    if (useUI.getState().quality !== "off") {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {
        /* DOM renderer fallback */
      }
    }

    // Home-folder paths open in Files.
    disposables.push(
      term.registerLinkProvider({
        provideLinks(y, callback) {
          const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
          const links = [...line.matchAll(HOME_PATH)].map((m) => ({
            text: m[0],
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            activate: () => openInFiles(m[0]),
            decorations: { underline: true, pointerCursor: true },
          }));
          callback(links.length ? links : undefined);
        },
      }),
    );

    disposables.push(
      term.onData((data) => {
        let out = data;
        if (mods.current.ctrl && data.length === 1) {
          const c = data.toUpperCase().charCodeAt(0);
          if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
        }
        if (mods.current.alt) out = `\x1b${out}`;
        if (mods.current.ctrl || mods.current.alt) {
          mods.current = { ctrl: false, alt: false };
          cb.current.onModifierUsed();
        }
        sendBytes(out);
      }),
      term.onBinary((data) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 255));
      }),
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel && useTermPrefs.getState().copyOnSelect)
          navigator.clipboard?.writeText(sel).catch(() => undefined);
      }),
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }),
    );

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => undefined);
        return false;
      }
      if (k === "v") {
        navigator.clipboard
          ?.readText()
          .then((t) => term.paste(t))
          .catch(() => undefined);
        return false;
      }
      if (k === "f") {
        cb.current.onSearchShortcut();
        return false;
      }
      return true;
    });

    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      cb.current.onContextMenu(e.clientX, e.clientY);
    };
    el.addEventListener("contextmenu", onCtx);
    const onFocusIn = () => cb.current.onFocus();
    el.addEventListener("focusin", onFocusIn);

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* not yet measurable */
        }
      }
    });
    ro.observe(el);
    termRef.current = term;
    return () => {
      ro.disconnect();
      el.removeEventListener("contextmenu", onCtx);
      el.removeEventListener("focusin", onFocusIn);
      disposables.forEach((d) => d.dispose());
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Live prefs and theme.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = FONT_STACK[prefs.font];
    term.options.fontSize = prefs.fontSize;
  }, [prefs.font, prefs.fontSize]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(themeId, mode);
  }, [mode, themeId]);

  // Attach to the server PTY (re-runs on "take over").
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let stopped = false;
    let attempt = 0;
    let timer: number | null = null;
    const connect = () => {
      cb.current.onStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${encodeURIComponent(props.termId)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      let replay = true;
      ws.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) {
          if (replay) {
            replay = false;
            term.reset();
          }
          term.write(new Uint8Array(m.data));
          return;
        }
        try {
          const msg = JSON.parse(String(m.data)) as {
            type: string;
            title?: string;
            alive?: boolean;
            exit_code?: number | null;
            code?: number;
          };
          if (msg.type === "ready") {
            attempt = 0;
            if (msg.title) cb.current.onTitle(msg.title);
            cb.current.onStatus(msg.alive === false ? "exited" : "live", msg.exit_code ?? null);
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } else if (msg.type === "title" && msg.title) {
            cb.current.onTitle(msg.title);
          } else if (msg.type === "exit") {
            cb.current.onStatus("exited", msg.code ?? null);
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        if (ev.code === 4404) return cb.current.onStatus("gone");
        if (ev.code === 4409) return cb.current.onStatus("elsewhere");
        if (ev.code === 4401 || ev.code === 4423 || ev.code === 4403) return; // locked/signed out: the shell remounts on unlock
        cb.current.onStatus("offline");
        const delay = Math.min(10000, 400 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
        timer = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      wsRef.current?.close(1000);
      wsRef.current = null;
    };
  }, [props.termId, attachKey]);

  useEffect(() => {
    if (props.focused) termRef.current?.focus();
  }, [props.focused]);

  useImperativeHandle(ref, () => ({
    send: (text) => sendBytes(text),
    focus: () => termRef.current?.focus(),
    selection: () => termRef.current?.getSelection() ?? "",
    tail: (n) => {
      const t = termRef.current;
      if (!t) return "";
      const b = t.buffer.active;
      const lines: string[] = [];
      for (let y = Math.max(0, b.baseY + b.cursorY - n * 2); y <= b.baseY + b.cursorY; y++) {
        lines.push(b.getLine(y)?.translateToString(true) ?? "");
      }
      return lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .split("\n")
        .slice(-n)
        .join("\n")
        .trim();
    },
    search: (q, dir) =>
      !!searchRef.current &&
      (dir === "next"
        ? searchRef.current.findNext(q, { caseSensitive: false, decorations: searchDecorations(mode) })
        : searchRef.current.findPrevious(q, { caseSensitive: false, decorations: searchDecorations(mode) })),
    clearSearch: () => searchRef.current?.clearDecorations(),
    copy: () => {
      const sel = termRef.current?.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => undefined);
    },
    paste: () => {
      navigator.clipboard
        ?.readText()
        .then((t) => termRef.current?.paste(t))
        .catch(() => undefined);
    },
    clear: () => termRef.current?.clear(),
    takeOver: () => setAttachKey((k) => k + 1),
    setModifiers: (m) => {
      mods.current = m;
      termRef.current?.focus();
    },
  }));

  return <div ref={host} className="kiln-term h-full w-full" onPointerDown={() => props.onFocus()} />;
});

function searchDecorations(mode: string) {
  const match = mode === "dark" ? "#4A3127" : "#F0D9CC";
  return {
    matchBackground: match,
    matchOverviewRuler: "#C96442",
    activeMatchBackground: mode === "dark" ? "#D97757" : "#C96442",
    activeMatchColorOverviewRuler: "#C96442",
  };
}
