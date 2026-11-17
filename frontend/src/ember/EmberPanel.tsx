/**
 * Ember's sidebar: chat with tool cards and approvals, image mode (ComfyUI), voice, screen sharing,
 * model picker, history. Opened by the orb on Home, the dock, Spotlight hand-offs and the Ember widget.
 * On desktop it docks flush to the right and the desktop shrinks beside it (see Shell); the default
 * export is the same UI as a normal app window.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  Mic,
  MonitorUp,
  Package,
  PanelRight,
  ScrollText,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  SquarePen,
  SquareTerminal,
  Trash2,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openInFiles } from "../apps/files/pending";
import { EmberGlyph } from "../components/Brand";
import { spring } from "../components/motion";
import { withReauth } from "../components/Reauth";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/store";
import type { AppProps } from "../shell/apps";
import { useWM } from "../shell/wm";
import "../previews/prose.css";
import { imageUrl, type Approval, type Call, type ImageSize, type Msg, type Risk } from "./api";
import { useEmber } from "./store";
import { setSpeakReplies, stopSpeaking, toggleListening, useVoice } from "./voice";

const TOOL_ICON: Record<string, LucideIcon> = {
  run_command: SquareTerminal,
  read_file: FileText,
  write_file: FileText,
  list_directory: FolderOpen,
  search_files: Search,
  system_status: Cpu,
  read_journal: ScrollText,
  search_packages: Package,
  generate_image: ImageIcon,
};

const TOOL_LABEL: Record<string, string> = {
  run_command: "Run a command",
  read_file: "Read a file",
  write_file: "Write a file",
  list_directory: "List a folder",
  search_files: "Search files",
  system_status: "Check system status",
  read_journal: "Read the journal",
  search_packages: "Search packages",
  generate_image: "Generate an image",
};

const RISK_STYLE: Record<Risk, string> = {
  safe: "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-success-ink",
  change: "bg-accent-soft text-accent-ink",
  danger: "bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-warn-ink",
  root: "bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-danger-ink",
};

const SIZE_LABEL: Partial<Record<ImageSize, string>> = {
  square: "Square",
  landscape: "Landscape",
  portrait: "Portrait",
};

export const PANEL_WIDTH = 440;

/** Ember as a normal app window (popped out of the sidebar). */
export default function EmberApp({ windowId }: AppProps) {
  const view = useEmber((s) => s.view);
  return (
    <div data-ember-panel className="flex h-full min-h-0 flex-col">
      <Header windowId={windowId} />
      {view === "history" ? <HistoryView /> : <ChatView />}
    </div>
  );
}

export function EmberPanel({ mobile }: { mobile: boolean }) {
  const open = useEmber((s) => s.open);
  const view = useEmber((s) => s.view);
  const name = useAuth((s) => s.assistantName);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && document.activeElement?.closest("[data-ember-panel]"))
        useEmber.getState().setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="ember"
          data-ember-panel
          aria-label={name}
          className={`fixed z-[25] flex flex-col overflow-hidden ${
            mobile ? "window inset-x-2 top-2 bottom-[70px] rounded-[24px]" : "top-0 right-0 bottom-0"
          }`}
          style={mobile ? undefined : { width: PANEL_WIDTH }}
          initial={{ opacity: 0, x: mobile ? 0 : 40, y: mobile ? 30 : 0, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
          exit={{
            opacity: 0,
            x: mobile ? 0 : 40,
            y: mobile ? 30 : 0,
            scale: 0.98,
            transition: { duration: 0.18 },
          }}
          transition={spring}
        >
          <Header />
          {view === "history" ? <HistoryView /> : <ChatView />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function IconButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-9 place-items-center rounded-full transition hover:bg-[var(--hairline)] disabled:opacity-40 ${
        active ? "bg-accent-soft text-accent-ink" : "text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

/** `windowId`: rendered inside an app window (its title bar already names Ember and closes it). */
function Header({ windowId }: { windowId?: string }) {
  const name = useAuth((s) => s.assistantName);
  const view = useEmber((s) => s.view);
  const streaming = useEmber((s) => s.streaming);
  const speaking = useVoice((s) => s.phase === "speaking");
  const speakReplies = useVoice((s) => s.speakReplies);
  const { setView, newChat, setOpen } = useEmber.getState();
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-3 py-2.5">
      {!windowId && (
        <>
          <EmberGlyph className="ml-1 size-6 text-accent" strokeWidth={1.5} />
          <h2 className="heading-display mr-1 ml-1.5 text-xl text-ink">{name}</h2>
        </>
      )}
      <ModelPicker />
      <div className="ml-auto flex items-center">
        <IconButton
          label={
            speaking ? "Stop speaking" : speakReplies ? "Stop reading replies aloud" : "Read replies aloud"
          }
          active={speakReplies}
          onClick={() => (speaking ? stopSpeaking() : setSpeakReplies(!speakReplies))}
        >
          {speakReplies || speaking ? (
            <Volume2 className="size-[18px]" strokeWidth={1.5} />
          ) : (
            <VolumeX className="size-[18px]" strokeWidth={1.5} />
          )}
        </IconButton>
        <IconButton
          label={view === "history" ? "Back to chat" : "Chats"}
          active={view === "history"}
          onClick={() => setView(view === "history" ? "chat" : "history")}
        >
          <History className="size-[18px]" strokeWidth={1.5} />
        </IconButton>
        <IconButton label="New chat" disabled={streaming} onClick={newChat}>
          <SquarePen className="size-[18px]" strokeWidth={1.5} />
        </IconButton>
        {windowId ? (
          <IconButton
            label="Dock to the sidebar"
            onClick={() => {
              useWM.getState().closeWindow(windowId);
              setOpen(true);
            }}
          >
            <PanelRight className="size-[18px]" strokeWidth={1.5} />
          </IconButton>
        ) : (
          <>
            <IconButton
              label="Open as a window"
              onClick={() => {
                setOpen(false);
                useWM.getState().openApp("assistant", { window: true });
              }}
            >
              <AppWindow className="size-[18px]" strokeWidth={1.5} />
            </IconButton>
            <IconButton label={`Close ${name}`} onClick={() => setOpen(false)}>
              <X className="size-[18px]" strokeWidth={1.5} />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

function ModelPicker() {
  const models = useEmber((s) => s.models);
  const current = useEmber((s) => s.currentModel);
  const reachable = useEmber((s) => s.reachable);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void useEmber.getState().loadModels();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes this menu, not the whole panel.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label = models.find((m) => m.id === current || m.aliases.includes(current))?.id ?? current;
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="num flex h-8 max-w-[170px] items-center gap-1.5 rounded-full border border-hairline px-3 text-xs text-ink-2 transition hover:text-ink"
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${reachable === false ? "bg-danger" : reachable ? "bg-success" : "bg-[var(--hairline-strong)]"}`}
        />
        <span className="truncate">{reachable === false ? "Offline" : label || "Model"}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label="Model"
            className="glass absolute top-10 left-0 z-10 w-64 rounded-[16px] p-1.5"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            {reachable === false && (
              <li className="px-3 py-2 text-sm text-ink-2">
                The model server isn't running. Start it with <code className="num">local-ai run</code>.
              </li>
            )}
            {models.map((m) => {
              const selected = m.id === current || m.aliases.includes(current);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false);
                      if (!selected) void useEmber.getState().setModel(m.id);
                    }}
                    className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-sm transition hover:bg-[var(--hairline)] ${
                      selected ? "text-ink" : "text-ink-2"
                    }`}
                  >
                    <span className="num min-w-0 flex-1 truncate">{m.id}</span>
                    {m.vision && (
                      <span className="rounded-full bg-[var(--hairline)] px-1.5 text-[10px]">vision</span>
                    )}
                    {m.status === "loaded" && (
                      <span className="text-[10px] text-success-ink" title="Loaded in memory">
                        loaded
                      </span>
                    )}
                    {selected && <Check className="size-4 text-accent-ink" />}
                  </button>
                </li>
              );
            })}
            <li className="px-3 pt-1.5 pb-1 text-[11px] text-ink-2">
              From AXION. Switching loads the model on your next message.
            </li>
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function HistoryView() {
  const conversations = useEmber((s) => s.conversations);
  const currentId = useEmber((s) => s.conversationId);
  const { load, remove } = useEmber.getState();
  if (!conversations.length)
    return <p className="flex flex-1 items-center justify-center p-8 text-sm text-ink-2">No chats yet.</p>;
  return (
    <ul className="flex-1 overflow-y-auto p-2">
      {conversations.map((c) => (
        <li key={c.id} className="group flex items-center">
          <button
            type="button"
            onClick={() => void load(c.id)}
            className={`flex min-w-0 flex-1 flex-col rounded-[12px] px-3 py-2 text-left transition hover:bg-[var(--hairline)] ${
              c.id === currentId ? "bg-accent-soft" : ""
            }`}
          >
            <span className="truncate text-sm text-ink">{c.title}</span>
            <span className="num text-[11px] text-ink-2">
              {new Date(c.updated_at * 1000).toLocaleString()}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Delete “${c.title}”`}
            onClick={() => void remove(c.id)}
            className="grid size-8 place-items-center rounded-full text-ink-2 opacity-0 transition group-hover:opacity-100 hover:text-danger-ink focus-visible:opacity-100"
          >
            <Trash2 className="size-4" strokeWidth={1.5} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChatView() {
  const messages = useEmber((s) => s.messages);
  const calls = useEmber((s) => s.calls);
  const liveCalls = useEmber((s) => s.liveCalls);
  const draft = useEmber((s) => s.draft);
  const thinking = useEmber((s) => s.thinking);
  const streaming = useEmber((s) => s.streaming);
  const error = useEmber((s) => s.error);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const visible = messages.filter((m) => m.role !== "tool");
  const lastIsUser = visible[visible.length - 1]?.role === "user";

  return (
    <>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {visible.length === 0 && !streaming ? (
          <Empty />
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((m) => (
              <MessageView key={m.id} m={m} calls={calls} />
            ))}
            {liveCalls.map((id) => calls[id] && <ToolCard key={id} call={calls[id]} />)}
            {thinking && !draft && (
              <p className="line-clamp-3 text-xs text-ink-2 italic">{thinking.slice(-400)}</p>
            )}
            {draft && <Markdown text={draft} />}
            {streaming && !draft && lastIsUser && liveCalls.length === 0 && (
              <span className="flex items-center gap-2 text-sm text-ink-2">
                <LoaderCircle className="size-4 animate-spin" /> Thinking…
              </span>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-[12px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2 text-sm text-danger-ink"
              >
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      <Composer />
    </>
  );
}

function Empty() {
  const name = useAuth((s) => s.assistantName);
  const user = useAuth((s) => s.displayName);
  const suggestions = [
    "How is my PC doing right now?",
    "What's taking the most space in my home folder?",
    "Are there package updates?",
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <EmberGlyph className="size-10 text-accent" strokeWidth={1.25} />
      <p className="max-w-[280px] text-sm text-ink-2">
        Hi{user ? ` ${user}` : ""}, I'm {name}. I can look around your PC, run commands with your OK, and make
        images.
      </p>
      <div className="flex flex-col items-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void useEmber.getState().send(s)}
            className="rounded-full border border-hairline px-3.5 py-1.5 text-sm text-ink transition hover:bg-[var(--hairline)]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="kiln-prose text-[14.5px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageView({ m, calls }: { m: Msg; calls: Record<string, Call> }) {
  if (m.role === "user")
    return (
      <div className="ml-10 self-end rounded-[18px] rounded-br-[6px] bg-accent-soft px-3.5 py-2 text-[14.5px] whitespace-pre-wrap text-ink">
        {m.data.screen && (
          <img
            src={m.data.screen}
            alt="Shared screen"
            className="mb-1.5 max-h-40 rounded-[10px] border border-hairline"
          />
        )}
        {m.data.kind === "image_request" && (
          <ImageIcon className="mr-1.5 mb-0.5 inline size-3.5 text-accent-ink" strokeWidth={1.75} />
        )}
        {m.content}
      </div>
    );
  if (m.data.kind === "image")
    return (
      <div className="flex flex-col gap-1.5">
        <Images paths={m.data.images ?? []} />
        <p className="num text-[11px] text-ink-2">Z-Image Turbo · seed {m.data.seed}</p>
      </div>
    );
  if (m.data.error)
    return (
      <p className="rounded-[12px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2 text-sm text-danger-ink">
        {m.data.error}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {m.content.trim() && <Markdown text={m.content} />}
      {(m.data.tool_calls ?? []).map((c) => calls[c.id] && <ToolCard key={c.id} call={calls[c.id]!} />)}
    </div>
  );
}

function Images({ paths }: { paths: string[] }) {
  return (
    <div className="grid gap-2">
      {paths.map((p) => (
        <figure key={p} className="group relative overflow-hidden rounded-[16px] border border-hairline">
          <button
            type="button"
            className="block w-full"
            onClick={() => openInFiles(p)}
            aria-label={`Open ${p} in Files`}
          >
            <img src={imageUrl(p)} alt="" loading="lazy" className="block w-full" />
          </button>
          <a
            href={`${imageUrl(p)}&download=1`}
            aria-label="Download image"
            className="glass absolute top-2 right-2 grid size-8 place-items-center rounded-full text-ink opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Download className="size-4" strokeWidth={1.5} />
          </a>
        </figure>
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<Call["status"], string> = {
  pending: "Starting",
  awaiting: "Needs your OK",
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
};

function ToolCard({ call }: { call: Call }) {
  const approval = useEmber((s) => s.approvals.find((a) => a.call_id === call.id));
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICON[call.name] ?? Sparkles;
  const busy = call.status === "pending" || call.status === "running";
  const isImage = call.name === "generate_image";
  const showOutput = !isImage && call.output && (expanded || call.status === "running");
  return (
    <div className="rounded-[16px] border border-hairline bg-[color-mix(in_srgb,var(--surface)_60%,transparent)]">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon className="size-4 shrink-0 text-ink-2" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          {call.summary === call.name ? (TOOL_LABEL[call.name] ?? call.name) : call.summary}
        </span>
        {call.risk !== "safe" && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${RISK_STYLE[call.risk]}`}
          >
            {call.risk}
          </span>
        )}
        <span
          className={`flex items-center gap-1 text-xs ${
            call.status === "error" || call.status === "denied"
              ? "text-danger-ink"
              : call.status === "awaiting"
                ? "text-warn-ink"
                : "text-ink-2"
          }`}
        >
          {busy && <LoaderCircle className="size-3.5 animate-spin" />}
          {call.status === "ok" && <Check className="size-3.5" />}
          {call.status === "denied" && <Ban className="size-3.5" />}
          {STATUS_TEXT[call.status]}
        </span>
        {!isImage && (
          <ChevronRight className={`size-3.5 text-ink-2 transition ${expanded ? "rotate-90" : ""}`} />
        )}
      </button>
      {call.detail && (call.name === "run_command" || expanded || approval) && (
        <pre className="num mx-3 mb-2 max-h-48 overflow-auto rounded-[10px] bg-[var(--hairline)] px-2.5 py-1.5 text-xs whitespace-pre-wrap text-ink">
          {call.name === "run_command" ? `$ ${call.detail}` : call.detail}
        </pre>
      )}
      {approval && <ApprovalForm a={approval} />}
      {isImage && busy && (
        <div className="mx-3 mb-3 grid aspect-square place-items-center rounded-[12px] bg-[var(--hairline)] text-sm text-ink-2">
          <span className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" /> {call.output || "Starting…"}
          </span>
        </div>
      )}
      {isImage && call.status === "error" && (
        <p className="mx-3 mb-2 text-xs text-danger-ink">{call.output}</p>
      )}
      {isImage && call.images.length > 0 && (
        <div className="mx-3 mb-3">
          <Images paths={call.images} />
        </div>
      )}
      {showOutput && (
        <pre className="num mx-3 mb-3 max-h-64 overflow-auto rounded-[10px] bg-[var(--hairline)] px-2.5 py-1.5 text-xs whitespace-pre-wrap text-ink-2">
          {call.output}
        </pre>
      )}
    </div>
  );
}

function ApprovalForm({ a }: { a: Approval }) {
  const [typed, setTyped] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = (a.mode !== "typed" || typed.trim() === a.expect) && (!a.sudo || pw.length > 0);

  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const body = { approve, typed, sudo_password: a.sudo && approve ? pw : null };
    try {
      const call = () => api(`/api/ember/approvals/${a.id}`, { method: "POST", body });
      await (approve && a.reauth ? withReauth("Confirm your password to allow this", call) : call());
      useEmber.getState().resolveApproval(a.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't send your answer");
    } finally {
      setPw("");
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) void decide(true);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mx-3 mb-3 flex flex-col gap-2 rounded-[12px] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] p-2.5"
    >
      <p className="flex items-start gap-1.5 text-xs text-ink">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-warn-ink" />
        <span>
          {a.reason ? `This ${a.reason}.` : "Ember wants to do this."}
          {a.risk === "root" && " It runs as root."}
          {a.reauth && " You'll confirm your Kiln password."}
        </span>
      </p>
      {a.mode === "typed" && (
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type ${a.expect} to confirm`}
          aria-label={`Type ${a.expect} to confirm`}
          autoComplete="off"
          spellCheck={false}
          className="num h-9 rounded-[10px] border border-hairline bg-[var(--surface)] px-3 text-sm text-ink outline-none focus:border-accent"
        />
      )}
      {a.sudo && (
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="sudo password (used once, never stored)"
          aria-label="sudo password"
          autoComplete="off"
          className="h-9 rounded-[10px] border border-hairline bg-[var(--surface)] px-3 text-sm text-ink outline-none focus:border-accent"
        />
      )}
      {err && <p className="text-xs text-danger-ink">{err}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide(false)}
          className="h-8 rounded-full px-3.5 text-sm text-ink-2 transition hover:bg-[var(--hairline)]"
        >
          Deny
        </button>
        <button
          type="submit"
          disabled={busy || !ready}
          className="hover-lift h-8 rounded-full bg-accent-fill px-4 text-sm text-on-accent disabled:opacity-40"
        >
          {a.risk === "danger" || a.risk === "root" ? "Allow anyway" : "Allow"}
        </button>
      </div>
    </form>
  );
}

function Composer() {
  const name = useAuth((s) => s.assistantName);
  const streaming = useEmber((s) => s.streaming);
  const mode = useEmber((s) => s.mode);
  const size = useEmber((s) => s.imageSize);
  const prefill = useEmber((s) => s.prefill);
  const open = useEmber((s) => s.open);
  const voice = useVoice((s) => s.phase);
  const screen = useEmber((s) => s.screen);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const { send, stop, setMode, setImageSize } = useEmber.getState();

  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.focus());
  }, [open]);

  useEffect(() => {
    if (prefill !== null && !streaming) {
      const p = useEmber.getState().takePrefill();
      if (p) setText(p);
    }
  }, [prefill, streaming]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const canSend = !!text.trim() || (mode === "chat" && !!screen);
  const submit = () => {
    if (!canSend || streaming) return;
    void send(text);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const sizes = useMemo(() => Object.entries(SIZE_LABEL) as [ImageSize, string][], []);

  return (
    <div className="shrink-0 border-t border-hairline p-3">
      <div className="pill-focus rounded-[20px] border border-hairline bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] px-3 pt-2.5 pb-2">
        {screen && mode === "chat" && (
          <div className="group relative mb-2 w-fit">
            <img
              src={screen}
              alt="Screen to share"
              className="max-h-20 rounded-[10px] border border-hairline"
            />
            <button
              type="button"
              onClick={() => useEmber.getState().clearScreen()}
              aria-label="Remove the screenshot"
              className="glass absolute -top-2 -right-2 grid size-6 place-items-center rounded-full text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={mode === "image" ? "Describe an image…" : `Ask ${name}…`}
          aria-label={mode === "image" ? "Describe an image" : `Message ${name}`}
          className="block max-h-[180px] w-full resize-none bg-transparent text-[15px] text-ink outline-none"
        />
        <div className="mt-2 flex items-center gap-1.5">
          <div role="radiogroup" aria-label="Mode" className="flex rounded-full bg-[var(--hairline)] p-0.5">
            {(
              [
                ["chat", MessageCircle, "Chat"],
                ["image", ImageIcon, "Image"],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={mode === id}
                onClick={() => setMode(id)}
                className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition ${
                  mode === id ? "bg-[var(--surface-strong)] text-ink shadow-sm" : "text-ink-2"
                }`}
              >
                <Icon className="size-3.5" strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
          {mode === "image" && (
            <select
              value={size}
              onChange={(e) => setImageSize(e.target.value as ImageSize)}
              aria-label="Image size"
              className="h-7 rounded-full border border-hairline bg-transparent px-2 text-xs text-ink-2 outline-none"
            >
              {sizes.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <span className="flex-1" />
          {mode === "chat" && (
            <button
              type="button"
              onClick={() => void useEmber.getState().attachScreen()}
              aria-label={`Show ${name} your screen`}
              title={`Show ${name} your screen`}
              className={`grid size-8 place-items-center rounded-full transition hover:bg-[var(--hairline)] ${
                screen ? "text-accent-ink" : "text-ink-2"
              }`}
            >
              <MonitorUp className="size-4" strokeWidth={1.75} />
            </button>
          )}
          {mode === "chat" && (
            <button
              type="button"
              onClick={() => void toggleListening()}
              disabled={voice === "transcribing"}
              aria-pressed={voice === "listening"}
              aria-label={voice === "listening" ? "Stop listening" : `Speak to ${name}`}
              title={voice === "listening" ? "Stop listening" : `Speak to ${name} (Ctrl+Alt+Space)`}
              className={`grid size-8 place-items-center rounded-full transition disabled:opacity-40 ${
                voice === "listening"
                  ? "bg-accent-soft text-accent-ink"
                  : "text-ink-2 hover:bg-[var(--hairline)]"
              }`}
            >
              {voice === "transcribing" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Mic
                  className={`size-4 ${voice === "listening" ? "animate-pulse" : ""}`}
                  strokeWidth={1.75}
                />
              )}
            </button>
          )}
          {streaming ? (
            <button
              type="button"
              onClick={() => void stop()}
              aria-label="Stop"
              className="grid size-8 place-items-center rounded-full bg-[var(--hairline-strong)] text-ink"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={mode === "image" ? "Generate" : "Send"}
              className="hover-lift grid size-8 place-items-center rounded-full bg-accent-fill text-on-accent disabled:opacity-40"
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
