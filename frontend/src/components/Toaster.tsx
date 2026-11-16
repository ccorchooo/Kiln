import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, ChevronDown, Info, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useToasts, type Toast } from "../lib/toasts";
import { spring } from "./motion";

const ICONS = { info: Info, success: CheckCircle2, warn: TriangleAlert, error: AlertCircle };
const TONE = {
  info: "text-ink-2",
  success: "text-success-ink",
  warn: "text-warn-ink",
  error: "text-danger-ink",
};

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [open, setOpen] = useState(false);
  const Icon = ICONS[toast.tone];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.2 } }}
      transition={spring}
      className="glass pointer-events-auto w-[min(380px,calc(100vw-32px))] rounded-[16px] p-4"
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 size-[18px] shrink-0 ${TONE[toast.tone]}`} strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-ink">{toast.title}</p>
          {toast.message && <p className="mt-0.5 text-sm text-ink-2">{toast.message}</p>}
          {toast.details && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="mt-2 inline-flex items-center gap-1 rounded-[10px] text-xs text-ink-2 hover:text-ink"
              aria-expanded={open}
            >
              Details
              <ChevronDown
                className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                strokeWidth={1.5}
              />
            </button>
          )}
          {open && (
            <pre className="num mt-2 max-h-48 overflow-auto rounded-[10px] bg-[var(--hairline)] p-2 text-xs whitespace-pre-wrap text-ink-2">
              {toast.details}
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          className="rounded-full p-1 text-ink-2 hover:text-ink"
          aria-label="Dismiss"
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      </div>
    </motion.div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-24 z-50 flex flex-col items-end gap-2 md:right-6"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
