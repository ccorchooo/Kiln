import { useEffect } from "react";
import { api } from "./api";
import { lockNow } from "./auth";
import { useAuth } from "./store";

const HEARTBEAT_MS = 60_000;

/** Reports activity to the server (which enforces auto-lock) and locks locally when idle. */
export function useIdleLock(active: boolean): void {
  const minutes = useAuth((s) => s.idleLockMinutes);
  useEffect(() => {
    if (!active) return;
    let lastInput = Date.now();
    let lastBeat = 0;
    const mark = () => {
      lastInput = Date.now();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const tick = window.setInterval(() => {
      const now = Date.now();
      if (minutes > 0 && now - lastInput > minutes * 60_000) {
        void lockNow();
        return;
      }
      if (lastInput > lastBeat && now - lastBeat >= HEARTBEAT_MS) {
        lastBeat = now;
        api("/api/auth/heartbeat", { method: "POST" }).catch(() => undefined);
      }
    }, 5_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      window.clearInterval(tick);
    };
  }, [active, minutes]);
}
