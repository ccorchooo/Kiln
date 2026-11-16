import { motion } from "framer-motion";
import { Lock, Power } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { ClockPill } from "../components/ClockPill";
import { fade, spring } from "../components/motion";
import { lockNow, panicNow } from "../lib/auth";
import { useAuth } from "../lib/store";
import { useToasts } from "../lib/toasts";
import { OrbAnchor } from "../three/OrbAnchor";

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
}

const HOLD_MS = 700;

/** Panic needs a short press-and-hold on the button (the hotkey is instant). */
function PanicButton() {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const start = () => {
    setHolding(true);
    timer.current = window.setTimeout(() => void panicNow(), HOLD_MS);
  };
  const cancel = () => {
    setHolding(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
  };
  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !e.repeat && start()}
      onKeyUp={cancel}
      className="relative grid size-9 place-items-center overflow-hidden rounded-full text-ink-2 transition hover:-translate-y-px hover:text-danger-ink"
      aria-label="Panic: hold to end every session and kill terminals"
      title="Hold to panic-lock (Ctrl+Alt+Shift+K)"
    >
      <motion.span
        className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--danger)_25%,transparent)]"
        initial={false}
        animate={{ scale: holding ? 1 : 0, opacity: holding ? 1 : 0 }}
        transition={{ duration: holding ? HOLD_MS / 1000 : 0.2, ease: "linear" }}
      />
      <Power className="relative size-[18px]" strokeWidth={1.5} />
    </button>
  );
}

/**
 * Phase 1 Home: centered orb, greeting, ask pill, and a temporary island (Lock / Panic).
 * Phase 2 replaces the island with the full three-pill taskbar.
 */
export function Desktop() {
  const name = useAuth((s) => s.displayName);
  const assistant = useAuth((s) => s.assistantName);
  const [ask, setAsk] = useState("");
  const push = useToasts((s) => s.push);

  const onAsk = (e: FormEvent) => {
    e.preventDefault();
    if (!ask.trim()) return;
    push({
      tone: "info",
      title: `${assistant} isn't connected yet`,
      message: "The assistant arrives in Phase 6.",
    });
    setAsk("");
  };

  return (
    <motion.main className="fixed inset-0 z-10" aria-label="Home">
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-24">
        <OrbAnchor
          className="aspect-square w-[min(38vh,62vw)]"
          label={`Talk to ${assistant}`}
          onActivate={() => push({ tone: "info", title: "Voice arrives in Phase 7" })}
        />
        <motion.h1
          className="heading-display mt-6 px-6 text-center text-[clamp(1.75rem,3.2vw,2.6rem)] text-ink"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { ...fade, delay: 0.15 } }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          {greeting()}
          {name ? `, ${name}` : ""}
        </motion.h1>
        <motion.form
          onSubmit={onAsk}
          className="glass pill-focus mt-6 flex h-12 w-[min(440px,calc(100vw-32px))] items-center rounded-full px-5"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { ...fade, delay: 0.22 } }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask anything…"
            aria-label={`Ask ${assistant}`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
          />
        </motion.form>
      </div>

      <div className="absolute inset-x-0 bottom-[max(12px,env(safe-area-inset-bottom))] flex items-center justify-center gap-3 px-4">
        <motion.nav
          layoutId="primary-pill"
          transition={spring}
          className="glass flex h-12 items-center gap-1 rounded-full px-1.5"
          aria-label="Session"
        >
          <button
            type="button"
            onClick={() => void lockNow()}
            className="grid size-9 place-items-center rounded-full text-ink-2 transition hover:-translate-y-px hover:text-ink"
            aria-label="Lock (Ctrl+Alt+L)"
            title="Lock (Ctrl+Alt+L)"
          >
            <Lock className="size-[18px]" strokeWidth={1.5} />
          </button>
          <PanicButton />
        </motion.nav>
        <ClockPill />
      </div>
    </motion.main>
  );
}
