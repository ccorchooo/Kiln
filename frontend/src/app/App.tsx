import { AnimatePresence, LayoutGroup } from "framer-motion";
import { lazy, Suspense, useEffect, useRef } from "react";
import { ReauthDialog } from "../components/Reauth";
import { Toaster } from "../components/Toaster";
import { lockNow, panicNow, refreshAuth } from "../lib/auth";
import { EventSocket } from "../lib/events";
import { useAuth } from "../lib/store";
import { toastError } from "../lib/toasts";
import { useIdleLock } from "../lib/useIdleLock";
import { useAppearance, type Appearance } from "../theme/useAppearance";
import { MetricsSocket, useWidgets, widgetTopics } from "../widgets/store";
import { LockScreen } from "./LockScreen";
import { Shell } from "../shell/Shell";

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
          case "widgets":
            void useWidgets.getState().load();
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

  // Widget config + live metrics for the taskbar and the lock screen (server filters while locked).
  const widgets = useWidgets((s) => s.widgets);
  const topicsKey = widgetTopics(widgets).join(",");
  useEffect(() => {
    if (hasSession) void useWidgets.getState().load();
  }, [hasSession, status]);
  const metricsRef = useRef<MetricsSocket | null>(null);
  useEffect(() => {
    if (!hasSession) return;
    const sock = new MetricsSocket();
    metricsRef.current = sock;
    sock.start(widgetTopics(useWidgets.getState().widgets));
    return () => {
      sock.stop();
      metricsRef.current = null;
    };
  }, [hasSession]);
  useEffect(() => {
    metricsRef.current?.setTopics(topicsKey ? topicsKey.split(",") : []);
  }, [topicsKey]);

  useIdleLock(status === "unlocked");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "k") {
        e.preventDefault();
        e.stopPropagation();
        void panicNow();
      } else if (!e.shiftKey && key === "l" && useAuth.getState().status === "unlocked") {
        e.preventDefault();
        e.stopPropagation();
        void lockNow();
      }
    };
    // Capture phase: global shortcuts must win over focused apps (xterm stops propagation).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
            <Shell key="shell" />
          ) : status === "loading" ? null : (
            <LockScreen key="lock" />
          )}
        </AnimatePresence>
      </LayoutGroup>
      <Toaster />
      <ReauthDialog />
    </>
  );
}
