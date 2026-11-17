/** Small building blocks shared by the System app's sections. */
import { Search, ShieldAlert } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { withReauth } from "../../components/Reauth";
import { ApiError } from "../../lib/api";
import { toastError } from "../../lib/toasts";

export function Card({
  title,
  extra,
  children,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[18px] border border-hairline bg-[color-mix(in_srgb,var(--surface)_55%,transparent)] p-4">
      {(title || extra) && (
        <header className="mb-3 flex items-center gap-2">
          <h3 className="text-sm font-medium text-ink">{title}</h3>
          <div className="ml-auto flex items-center gap-2">{extra}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Bar({
  value,
  tone = "accent",
}: {
  value: number | null | undefined;
  tone?: "accent" | "warn";
}) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const color = tone === "warn" || v >= 90 ? "bg-warn" : "bg-accent";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]" role="presentation">
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-500`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

/** Area chart over the last samples; `max` fixes the scale (e.g. 100 for percentages). */
export function Chart({
  values,
  max,
  className = "h-16",
}: {
  values: number[];
  max?: number;
  className?: string;
}) {
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const n = values.length;
  const pts = values.map((v, i) => `${n > 1 ? (i / (n - 1)) * 100 : 0},${40 - (v / top) * 38}`);
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden>
      {n > 1 && (
        <>
          <polygon points={`0,40 ${pts.join(" ")} 100,40`} className="fill-[var(--accent-soft)]" />
          <polyline
            points={pts.join(" ")}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeWidth={1.5}
            className="stroke-[var(--accent)]"
          />
        </>
      )}
    </svg>
  );
}

export function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline px-3 focus-within:border-accent">
      <Search className="size-4 shrink-0 text-ink-2" strokeWidth={1.5} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
      />
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 rounded-full bg-[var(--hairline)] p-0.5"
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`h-8 rounded-full px-3.5 text-sm transition ${
            value === v ? "bg-[var(--surface-strong)] text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A button that asks "Sure?" in place for a few seconds before running. */
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
  danger = false,
  disabled = false,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3500);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      className={`h-7 shrink-0 rounded-full px-3 text-xs transition disabled:opacity-40 ${
        armed
          ? danger
            ? "bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] text-danger-ink"
            : "bg-accent-soft text-accent-ink"
          : "text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
      }`}
    >
      {armed ? confirm : label}
    </button>
  );
}

interface SudoAsk {
  label: string;
  run: (password: string) => Promise<unknown>;
  error?: string;
}

/**
 * Run an action that needs a fresh Kiln password, and root if the server says so: the sudo
 * password is asked for inline, sent once, and dropped right after.
 */
export function useRootAction(onDone?: () => void) {
  const [ask, setAsk] = useState<SudoAsk | null>(null);

  const finish = (label: string, err: unknown, retry: SudoAsk["run"]) => {
    if (err instanceof ApiError && (err.code === "sudo_required" || err.code === "sudo_rejected"))
      setAsk({ label, run: retry, error: err.code === "sudo_rejected" ? err.message : undefined });
    else toastError(`Couldn't ${label.toLowerCase()}`, err);
  };

  const act = async (label: string, call: (sudoPassword?: string) => Promise<unknown>) => {
    setAsk(null);
    try {
      await withReauth(`Confirm your password to ${label.toLowerCase()}`, () => call());
      onDone?.();
    } catch (err) {
      finish(label, err, call);
    }
  };

  const prompt = ask && (
    <SudoPrompt
      ask={ask}
      onCancel={() => setAsk(null)}
      onSubmit={async (pw) => {
        try {
          await withReauth(`Confirm your password to ${ask.label.toLowerCase()}`, () => ask.run(pw));
          setAsk(null);
          onDone?.();
        } catch (err) {
          finish(ask.label, err, ask.run);
        }
      }}
    />
  );
  return { act, prompt };
}

function SudoPrompt({
  ask,
  onCancel,
  onSubmit,
}: {
  ask: SudoAsk;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    try {
      await onSubmit(pw);
    } finally {
      setPw("");
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 rounded-[14px] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] px-3 py-2"
    >
      <ShieldAlert className="size-4 shrink-0 text-warn-ink" />
      <span className="text-sm text-ink">
        {ask.label} needs root.{ask.error ? ` ${ask.error}` : ""}
      </span>
      <input
        type="password"
        autoFocus
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="sudo password (used once, never stored)"
        aria-label="sudo password"
        autoComplete="off"
        className="h-8 min-w-[220px] flex-1 rounded-[10px] border border-hairline bg-[var(--surface)] px-3 text-sm text-ink outline-none focus:border-accent"
      />
      <button type="button" onClick={onCancel} className="h-8 rounded-full px-3 text-sm text-ink-2">
        Cancel
      </button>
      <button
        type="submit"
        disabled={!pw || busy}
        className="h-8 rounded-full bg-accent-fill px-4 text-sm text-on-accent disabled:opacity-40"
      >
        Run
      </button>
    </form>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-ink-2">{children}</p>;
}
