import { AnimatePresence, LayoutGroup } from "framer-motion";
import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "../components/Toaster";
import { lockNow, panicNow, refreshAuth } from "../lib/auth";
import { EventSocket } from "../lib/events";
import { useAuth } from "../lib/store";
import { toastError } from "../lib/toasts";
import { useIdleLock } from "../lib/useIdleLock";
import { useAppearance, type Appearance } from "../theme/useAppearance";
import { Desktop } from "./Desktop";
import { LockScreen } from "./LockScreen";

// three.js + R3F load after first paint; the CSS wallpaper shows meanwhile.
const Scene = lazy(() => import("../three/Scene").then((m) => ({ default: m.Scene })));

export function App() {
  const accept = useAppearance();
  const status = useAuth((s) => s.status);
  const hasSession = status === "unlocked" || status === "locked";

  useEffect(() => {
    refreshAuth().catch((err) => {
      toastError("Can't reach Kiln", err);
      useAuth.getState().setStatus("signedOut");
    });
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    const socket = new EventSocket(
      (ev) => {
        const auth = useAuth.getState();
        switch (ev.kind) {
          case "session.locked":
            auth.setStatus("locked");
            break;
          case "session.unlocked":
            void refreshAuth();
            break;
          case "session.ended":
            auth.setStatus("signedOut");
            break;
          case "appearance":
            accept(ev.data as unknown as Appearance);
            break;
        }
      },
      () => void refreshAuth().catch(() => useAuth.getState().setStatus("signedOut")),
    );
    socket.start();
    return () => socket.stop();
  }, [hasSession, accept]);

  useIdleLock(status === "unlocked");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "k") {
        e.preventDefault();
        void panicNow();
      } else if (!e.shiftKey && key === "l" && useAuth.getState().status === "unlocked") {
        e.preventDefault();
        void lockNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="wallpaper-static grain fixed inset-0" aria-hidden />
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
      <LayoutGroup>
        <AnimatePresence mode="popLayout">
          {status === "unlocked" ? (
            <Desktop key="desktop" />
          ) : status === "loading" ? null : (
            <LockScreen key="lock" />
          )}
        </AnimatePresence>
      </LayoutGroup>
      <Toaster />
    </>
  );
}
