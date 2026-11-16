import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { spring } from "../components/motion";
import { api, ApiError } from "../lib/api";
import { refreshAuth } from "../lib/auth";
import { useAuth, type ServerAuthState } from "../lib/store";
import { toastError } from "../lib/toasts";

type UnlockResponse = ServerAuthState | { step: "totp"; challenge: string };

function formatWait(seconds: number): string {
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PasswordPill() {
  const status = useAuth((s) => s.status);
  const [stage, setStage] = useState<"password" | "totp">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [lockedOut, setLockedOut] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const controls = useAnimationControls();

  const waiting = retryUntil > now;
  const remaining = (retryUntil - now) / 1000;

  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [waiting]);

  useEffect(() => {
    if (!waiting && !busy) inputRef.current?.focus();
  }, [waiting, busy, stage]);

  const fail = async (err: unknown) => {
    if (!(err instanceof ApiError)) {
      toastError("Couldn't sign in", err);
      return;
    }
    if (err.code === "setup_required") {
      await refreshAuth();
      return;
    }
    if (err.code === "challenge_expired") {
      setStage("password");
      setCode("");
    }
    if (err.code === "csrf") {
      await refreshAuth();
    }
    if (err.status === 0) {
      toastError("Can't reach Kiln", err);
      return;
    }
    setLockedOut(err.code === "locked_out");
    if (err.retryAfter > 0) {
      setNow(Date.now());
      setRetryUntil(Date.now() + err.retryAfter * 1000);
    }
    setFlash(true);
    window.setTimeout(() => setFlash(false), 1600);
    void controls.start({ x: [0, -10, 9, -6, 4, -2, 0], transition: { duration: 0.42, ease: "easeOut" } });
  };

  const accept = (r: UnlockResponse) => {
    if ("step" in r) {
      setChallenge(r.challenge);
      setStage("totp");
      return;
    }
    useAuth.getState().fromServer(r);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || waiting) return;
    if (stage === "password" && !password) return;
    if (stage === "totp" && code.length < 6) return;
    setBusy(true);
    try {
      const r =
        stage === "password"
          ? await api<UnlockResponse>("/api/auth/unlock", { method: "POST", body: { password } })
          : await api<UnlockResponse>("/api/auth/totp", { method: "POST", body: { challenge, code } });
      setPassword("");
      setCode("");
      accept(r);
    } catch (err) {
      if (stage === "password") setPassword("");
      else setCode("");
      await fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (status === "setup") {
    return (
      <motion.div
        layoutId="primary-pill"
        transition={spring}
        className="glass flex h-12 w-full items-center rounded-full px-5 text-sm text-ink-2 md:w-auto"
      >
        Set a password on the host first:&nbsp;<code className="num text-ink">kiln set-password</code>
      </motion.div>
    );
  }

  const placeholder = waiting
    ? lockedOut
      ? `Too many tries · wait ${formatWait(remaining)}`
      : `Try again in ${formatWait(remaining)}`
    : stage === "password"
      ? "Password"
      : "6-digit code";

  return (
    <motion.form
      layoutId="primary-pill"
      transition={spring}
      animate={controls}
      onSubmit={submit}
      className="glass pill-focus relative flex h-12 w-full items-center overflow-hidden rounded-full md:w-[300px]"
      style={{
        boxShadow: flash ? "0 0 0 1.5px var(--danger), 0 10px 40px -12px var(--shadow-color)" : undefined,
        transition: "box-shadow 0.6s ease",
      }}
      aria-label="Unlock Kiln"
    >
      <input type="text" name="username" autoComplete="username" value="augus" readOnly hidden />
      <AnimatePresence mode="popLayout" initial={false}>
        {stage === "password" ? (
          <motion.input
            key="pw"
            ref={inputRef}
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={spring}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || waiting}
            placeholder={placeholder}
            aria-label="Password"
            aria-invalid={flash}
            className={`h-full min-w-0 flex-1 bg-transparent pr-12 pl-5 text-[15px] text-ink outline-none ${waiting ? "num text-sm" : ""}`}
          />
        ) : (
          <motion.div
            key="totp"
            className="flex h-full min-w-0 flex-1 items-center"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={spring}
          >
            <button
              type="button"
              onClick={() => {
                setStage("password");
                setCode("");
              }}
              className="ml-2 rounded-full p-2 text-ink-2 hover:text-ink"
              aria-label="Back to password"
            >
              <ArrowLeft className="size-4" strokeWidth={1.5} />
            </button>
            <input
              ref={inputRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
              }}
              onKeyUp={() => code.length === 6 && void submit()}
              disabled={busy || waiting}
              placeholder={placeholder}
              aria-label="Authenticator code"
              className="num h-full min-w-0 flex-1 bg-transparent pr-12 pl-1 text-[15px] tracking-[0.3em] text-ink outline-none placeholder:tracking-normal"
            />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(busy || (stage === "password" ? password : code.length === 6)) && !waiting && (
          <motion.button
            type="submit"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={spring}
            disabled={busy}
            className="absolute right-1.5 grid size-9 place-items-center rounded-full bg-accent-fill text-on-accent"
            aria-label="Unlock"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            ) : (
              <ArrowRight className="size-4" strokeWidth={1.75} />
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </motion.form>
  );
}
