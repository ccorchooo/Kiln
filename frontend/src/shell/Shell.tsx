/** The unlocked desktop: workspace strip (Home + workspaces), taskbar, Spotlight, task view. */
import { motion } from "framer-motion";
import { useEffect } from "react";
import { useIsMobile, useViewport } from "./hooks";
import { Spotlight } from "./Spotlight";
import { Strip } from "./Strip";
import { Taskbar } from "./Taskbar";
import { useWM } from "./wm";

export function Shell() {
  const { vw, vh } = useViewport();
  const mobile = useIsMobile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const wm = useWM.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        wm.setSpotlight(!wm.spotlight);
        return;
      }
      if ((e.ctrlKey && e.altKey && e.key === "Tab") || (e.metaKey && e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        wm.setTaskView(!wm.taskView);
        return;
      }
      if (e.ctrlKey && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        wm.step(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (wm.taskView && !wm.spotlight) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          wm.setTaskView(false);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          wm.step(e.key === "ArrowLeft" ? -1 : 1);
        }
      }
    };
    // Capture phase: global shortcuts must win over focused apps (xterm stops propagation).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Never leave overlays open across a lock.
  useEffect(
    () => () => {
      useWM.setState({ spotlight: false, taskView: false });
    },
    [],
  );

  return (
    <motion.main className="fixed inset-0 z-10" aria-label="Kiln desktop" exit={{ opacity: 1 }}>
      <Strip vw={vw} vh={vh} mobile={mobile} />
      <Taskbar mobile={mobile} />
      <Spotlight />
    </motion.main>
  );
}
