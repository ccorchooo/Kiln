/**
 * The unlocked desktop: workspace strip (Home + workspaces), taskbar, Spotlight, task view.
 * With Ember docked (desktop), the whole desktop shrinks into a rounded card and a solid frame
 * wraps around it and behind the sidebar.
 */
import { motion } from "framer-motion";
import { useEffect } from "react";
import { spring } from "../components/motion";
import { EmberPanel, PANEL_WIDTH } from "../ember/EmberPanel";
import { useEmber } from "../ember/store";
import { useIsMobile, useViewport } from "./hooks";
import { Spotlight } from "./Spotlight";
import { Strip } from "./Strip";
import { Taskbar } from "./Taskbar";
import { useWM } from "./wm";

export interface Desk {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const FULL: Desk = { left: 0, top: 0, right: 0, bottom: 0 };
const FRAME = 8;

export function Shell() {
  const { vw, vh } = useViewport();
  const mobile = useIsMobile();
  const docked = useEmber((s) => s.open) && !mobile;
  const desk: Desk = docked ? { left: FRAME, top: FRAME, right: PANEL_WIDTH, bottom: FRAME } : FULL;

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
      <Strip vw={vw - desk.left - desk.right} vh={vh - desk.top - desk.bottom} desk={desk} mobile={mobile} />
      {/* The frame: everything outside the card, via a huge spread shadow around its rounded hole. */}
      <motion.div
        aria-hidden
        className="pointer-events-none fixed z-[24]"
        initial={false}
        animate={{
          ...desk,
          borderRadius: docked ? 22 : 0,
          boxShadow: docked
            ? "0 0 0 1px var(--hairline), 0 0 0 200vmax var(--surface-solid)"
            : "0 0 0 0px var(--hairline), 0 0 0 200vmax transparent",
        }}
        transition={spring}
      />
      <EmberPanel mobile={mobile} />
      <Taskbar mobile={mobile} desk={desk} />
      <Spotlight />
    </motion.main>
  );
}
