/**
 * "Confirm your password" prompt. Anything that hits a `reauth_required` / `denied` error can
 * `await requireReauth(reason)` and retry when it resolves true.
 */
import { AnimatePresence, motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import { spring } from "./motion";

interface ReauthStore {
  reason: string | null;
  resolve: ((ok: boolean) => void) | null;
}

const useReauth = create<ReauthStore>(() => ({ reason: null, resolve: null }));

export function requireReauth(reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    useReauth.getState().resolve?.(false);
    useReauth.setState({ reason, resolve });
  });
}

/** Run `fn`; if the server asks for a fresh password, prompt once and retry. */
export async function withReauth<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && (err.code === "reauth_required" || err.code === "denied")) {
      if (await requireReauth(reason)) return fn();
    }
    throw err;
  }
}

export function ReauthDialog() {
  const { reason, resolve } = useReauth();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (reason) {
      setPw("");
      setError(null);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [reason]);

  const close = (ok: boolean) => {
    resolve?.(ok);
    useReauth.setState({ reason: null, resolve: null });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    try {
      await api("/api/auth/reauth", { method: "POST", body: { password: pw } });
      close(true);
    } catch (err) {
      setPw("");
      setError(
        err instanceof ApiError && err.status === 429
          ? `Too many tries. Wait ${Math.ceil(err.retryAfter)}s.`
          : "That didn't match.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {reason && (
        <>
          <motion.div
            key="reauth-bg"
            className="fixed inset-0 z-[80] bg-[color-mix(in_srgb,var(--bg)_40%,transparent)] backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => close(false)}
          />
          <motion.form
            key="reauth"
            onSubmit={submit}
            role="dialog"
            aria-label="Confirm your password"
            className="window fixed top-1/2 left-1/2 z-[81] flex w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-[24px] p-6"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={spring}
          >
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent-ink">
                <ShieldCheck className="size-5" strokeWidth={1.5} />
              </div>
              <h2 className="heading-display text-2xl text-ink">Confirm it's you</h2>
            </div>
            <p className="text-sm text-ink-2">{reason}</p>
            <input
              ref={input}
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              aria-invalid={!!error}
              className="h-11 rounded-full border border-[var(--hairline-strong)] bg-transparent px-4 text-[15px] text-ink outline-none focus:border-accent"
            />
            {error && <p className="text-sm text-danger-ink">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                className="rounded-full px-4 py-2 text-sm text-ink-2 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !pw}
                className="rounded-full bg-accent-fill px-5 py-2 text-sm text-on-accent disabled:opacity-60"
              >
                Confirm
              </button>
            </div>
          </motion.form>
        </>
      )}
    </AnimatePresence>
  );
}
