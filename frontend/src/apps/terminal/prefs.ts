import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TermFont = "geist" | "jetbrains";

interface TermPrefs {
  fontSize: number;
  font: TermFont;
  copyOnSelect: boolean;
  set: (p: Partial<Omit<TermPrefs, "set">>) => void;
}

export const FONT_STACK: Record<TermFont, string> = {
  geist: '"Geist Mono", ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, monospace',
};

export const useTermPrefs = create<TermPrefs>()(
  persist(
    (set) => ({
      fontSize: 14,
      font: "geist",
      copyOnSelect: true,
      set: (p) => set((s) => ({ ...s, ...p, fontSize: Math.min(28, Math.max(9, p.fontSize ?? s.fontSize)) })),
    }),
    {
      name: "kiln.term.prefs",
      partialize: (s) => ({ fontSize: s.fontSize, font: s.font, copyOnSelect: s.copyOnSelect }),
    },
  ),
);

/** Per-window tab layout (terminal ids live on the server and survive reloads). */
export interface TermTab {
  id: string;
  panes: string[]; // server terminal ids, 1–2
  split: "row" | "col";
  focus: number;
}

export interface TermLayout {
  tabs: TermTab[];
  active: number;
}

const key = (windowId: string) => `kiln.term.layout.${windowId}`;

export function loadLayout(windowId: string): TermLayout | null {
  try {
    const raw = localStorage.getItem(key(windowId));
    return raw ? (JSON.parse(raw) as TermLayout) : null;
  } catch {
    return null;
  }
}

export function saveLayout(windowId: string, layout: TermLayout): void {
  try {
    localStorage.setItem(key(windowId), JSON.stringify(layout));
  } catch {
    /* storage unavailable: layout lives for this page only */
  }
}

export function dropLayout(windowId: string): void {
  try {
    localStorage.removeItem(key(windowId));
  } catch {
    /* ignore */
  }
}

/** Working directory for the next new terminal ("Open in terminal here"). */
let pendingCwd: string | null = null;
export function takePendingCwd(): string | null {
  const c = pendingCwd;
  pendingCwd = null;
  return c;
}
export function setPendingCwd(path: string): void {
  pendingCwd = path;
}

/** Command typed into the next new terminal (the user sees it run, sudo prompts included). */
let pendingCommand: string | null = null;
export function takePendingCommand(): string | null {
  const c = pendingCommand;
  pendingCommand = null;
  return c;
}
export function setPendingCommand(command: string): void {
  pendingCommand = command;
}
