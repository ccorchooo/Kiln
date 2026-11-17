/** App registry. `pairable` apps may share a workspace with the current app (max 2 per workspace). */
import {
  FileCode2,
  Folder,
  Gauge,
  NotebookPen,
  ScrollText,
  Settings2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { EmberGlyph } from "../components/Brand";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export interface AppProps {
  windowId: string;
}

export interface AppDef {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  keywords: string[];
  pairable: boolean;
  multiInstance: boolean;
  /** Opens in Ember's sidebar by default; `openApp(id, { window: true })` makes it a window. */
  sidebar?: boolean;
  /** Phase in which the real app lands; placeholder until then. */
  phase?: number;
  component?: LazyExoticComponent<ComponentType<AppProps>>;
}

const SettingsApp = lazy(() => import("../apps/settings/SettingsApp"));
const TerminalApp = lazy(() => import("../apps/terminal/TerminalApp"));
const FilesApp = lazy(() => import("../apps/files/FilesApp"));
const EditorApp = lazy(() => import("../apps/editor/EditorApp"));
const EmberApp = lazy(() => import("../ember/EmberPanel"));

export const APPS: Record<string, AppDef> = {
  assistant: {
    id: "assistant",
    name: "Ember",
    icon: EmberGlyph,
    description: "Chat with Ember, review approvals and tool output.",
    keywords: ["ai", "assistant", "chat", "ask", "ember"],
    pairable: false,
    multiInstance: false,
    sidebar: true,
    component: EmberApp,
  },
  terminal: {
    id: "terminal",
    name: "Terminal",
    icon: SquareTerminal,
    description: "Your login shell, in a real PTY.",
    keywords: ["shell", "zsh", "console", "pty", "command"],
    pairable: true,
    multiInstance: true,
    component: TerminalApp,
  },
  files: {
    id: "files",
    name: "Files",
    icon: Folder,
    description: "Browse and manage your home folder.",
    keywords: ["file manager", "folder", "home", "browse", "explorer"],
    pairable: true,
    multiInstance: true,
    component: FilesApp,
  },
  editor: {
    id: "editor",
    name: "Editor",
    icon: FileCode2,
    description: "Edit text and code with Monaco.",
    keywords: ["code", "text", "monaco", "edit"],
    pairable: true,
    multiInstance: false,
    component: EditorApp,
  },
  notes: {
    id: "notes",
    name: "Notes",
    icon: NotebookPen,
    description: "A scratchpad synced to a file in your home folder.",
    keywords: ["scratchpad", "notes", "write", "memo"],
    pairable: true,
    multiInstance: false,
    phase: 10,
  },
  logs: {
    id: "logs",
    name: "Logs",
    icon: ScrollText,
    description: "Live journalctl with filters.",
    keywords: ["journal", "journalctl", "systemd", "log"],
    pairable: true,
    multiInstance: true,
    phase: 8,
  },
  system: {
    id: "system",
    name: "System",
    icon: Gauge,
    description: "Telemetry, processes, services, packages, network and power.",
    keywords: ["dashboard", "cpu", "gpu", "memory", "processes", "services", "packages", "monitor"],
    pairable: false,
    multiInstance: false,
    phase: 8,
  },
  settings: {
    id: "settings",
    name: "Settings",
    icon: Settings2,
    description: "Appearance, dock, sessions and security.",
    keywords: ["preferences", "appearance", "theme", "dark", "light", "dock", "sessions", "security"],
    pairable: false,
    multiInstance: false,
    component: SettingsApp,
  },
};

export const APP_ORDER = ["assistant", "terminal", "files", "editor", "notes", "logs", "system", "settings"];
export const MAX_PINNED = 5;
export const DEFAULT_PINNED = ["assistant", "terminal", "files", "system", "settings"];

export function AppPlaceholder({ app }: { app: AppDef }) {
  const Icon = app.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="grid size-14 place-items-center rounded-[16px] bg-accent-soft text-accent-ink">
        <Icon className="size-7" strokeWidth={1.5} />
      </div>
      <h2 className="heading-display text-2xl text-ink">{app.name}</h2>
      <p className="max-w-sm text-sm text-ink-2">{app.description}</p>
      {app.phase && <p className="num text-xs text-ink-2">Arrives in Phase {app.phase}</p>}
    </div>
  );
}
