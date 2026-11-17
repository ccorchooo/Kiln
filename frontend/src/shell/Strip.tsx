/**
 * Home + workspaces laid out side by side. Normal mode shows one page; task view scales the
 * whole strip down (live previews, GNOME-style) with neighbours peeking in from the sides.
 */
import { AnimatePresence, motion } from "framer-motion";
import { Plus } from "lucide-react";
import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { spring, springSoft } from "../components/motion";
import { PANEL_WIDTH } from "../ember/EmberPanel";
import { useEmber } from "../ember/store";
import { useVoice } from "../ember/voice";
import { useAuth } from "../lib/store";
import { useToasts } from "../lib/toasts";
import { OrbAnchor } from "../three/OrbAnchor";
import { APPS } from "./apps";
import { useSwipe } from "./hooks";
import { WorkspacePage } from "./WorkspacePage";
import { MAX_PER_WORKSPACE, useWM } from "./wm";

const PAGE_GAP = 72;
const TV_SCALE = 0.62;

function HomePage({ showOrb, mobile }: { showOrb: boolean; mobile: boolean }) {
  const assistant = useAuth((s) => s.assistantName);
  const taskView = useWM((s) => s.taskView);
  const panelOpen = useEmber((s) => s.open);
  // On desktop the sidebar covers the right; keep the orb centred in what's left.
  const shift = panelOpen && !mobile ? PANEL_WIDTH + 12 : 0;
  return (
    <div
      data-swipe
      className="absolute inset-0 flex flex-col items-center justify-center pb-24"
      style={{ paddingRight: shift }}
      inert={taskView}
    >
      <div className="relative">
        {showOrb && !(panelOpen && mobile) ? (
          <OrbAnchor
            untransformed
            refreshKey={shift}
            className="aspect-square w-[min(44vh,62vw)]"
            label={panelOpen ? `Close ${assistant}` : `Open ${assistant}`}
            onActivate={() => useEmber.getState().toggle()}
          />
        ) : (
          <div className="aspect-square w-[min(44vh,62vw)]" aria-hidden />
        )}
        <Captions />
      </div>
    </div>
  );
}

/** What Ember is hearing or saying, under the orb. */
function Captions() {
  const caption = useVoice((s) => s.caption);
  const speaking = useVoice((s) => s.phase === "speaking");
  return (
    <div
      aria-live="polite"
      className="absolute top-full left-1/2 mt-6 flex w-[min(560px,88vw)] -translate-x-1/2 justify-center"
    >
      <AnimatePresence mode="wait">
        {caption && (
          <motion.p
            key={caption}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
            transition={{ duration: 0.25 }}
            className={`glass rounded-[16px] px-4 py-2 text-center text-[15px] text-pretty ${
              speaking ? "text-ink" : "text-ink-2 italic"
            }`}
          >
            {caption}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

interface DragState {
  winId: string;
  sx: number;
  sy: number;
  x: number;
  y: number;
  moved: boolean;
}

export function Strip({ vw, vh, mobile }: { vw: number; vh: number; mobile: boolean }) {
  const workspaces = useWM((s) => s.workspaces);
  const current = useWM((s) => s.current);
  const taskView = useWM((s) => s.taskView);
  const windows = useWM((s) => s.windows);
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const pageW = vw + PAGE_GAP;

  const step = useCallback((d: number) => useWM.getState().step(d), []);
  const accept = useCallback(
    (t: EventTarget | null) =>
      useWM.getState().taskView || (t instanceof Element && !!t.closest("[data-swipe]")),
    [],
  );
  useSwipe(rootRef, step, accept);

  const startDrag = useCallback((winId: string, e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const st: DragState = { winId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    setDrag(st);
    const move = (ev: PointerEvent) => {
      st.x = ev.clientX;
      st.y = ev.clientY;
      st.moved ||= Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) > 6;
      setDrag({ ...st });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      const wm = useWM.getState();
      if (!st.moved) {
        wm.focusWindow(winId);
        return;
      }
      const target = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .map((n) => (n as HTMLElement).dataset?.page)
        .find((p) => p !== undefined);
      if (target === undefined || target === "-1") return;
      const ok = wm.moveWindow(winId, target === "new" ? "new" : Number(target));
      if (!ok)
        useToasts.getState().push({
          tone: "warn",
          title: "That workspace is full",
          message: `A workspace holds up to ${MAX_PER_WORKSPACE} apps.`,
        });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const pages = [{ id: "home", index: -1 }, ...workspaces.map((w, i) => ({ id: w.id, index: i }))];
  const label = (i: number) => (i < 0 ? "Home" : String(i + 1));

  return (
    <>
      <AnimatePresence>
        {taskView && (
          <motion.div
            key="tv-backdrop"
            className="fixed inset-0 z-[5] bg-[color-mix(in_srgb,var(--bg)_30%,transparent)] backdrop-blur-xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => useWM.getState().setTaskView(false)}
          />
        )}
      </AnimatePresence>
      <motion.div
        ref={rootRef}
        className="pointer-events-none fixed inset-0 z-[6]"
        initial={false}
        animate={{ scale: taskView ? TV_SCALE : 1 }}
        transition={springSoft}
        style={{ originY: 0.44 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
      >
        <motion.div
          className="absolute inset-0"
          initial={false}
          animate={{ x: -(current + 1) * pageW }}
          transition={spring}
        >
          {pages.map((p, i) => {
            const ws = p.index >= 0 ? workspaces[p.index] : undefined;
            const isCurrent = p.index === current;
            return (
              <motion.div
                key={p.id}
                data-page={p.index}
                data-orb-origin
                className="pointer-events-auto absolute top-0 overflow-visible"
                style={{ left: i * pageW, width: vw, height: vh }}
                initial={false}
                animate={{
                  borderRadius: taskView ? 40 : 0,
                  boxShadow: taskView
                    ? `0 0 0 ${isCurrent ? 4 : 1.5}px ${isCurrent ? "var(--accent)" : "var(--hairline-strong)"}, 0 40px 120px -40px var(--shadow-color)`
                    : "0 0 0 0px transparent",
                  backgroundColor: taskView
                    ? "color-mix(in srgb, var(--surface) 55%, transparent)"
                    : "rgba(0,0,0,0)",
                }}
                transition={springSoft}
                onClick={(e) => {
                  if (!taskView || (e.target as HTMLElement).closest("[data-window]")) return;
                  const wm = useWM.getState();
                  wm.goTo(p.index);
                  wm.setTaskView(false);
                }}
                aria-hidden={!taskView && !isCurrent}
                inert={!taskView && !isCurrent}
              >
                {p.index < 0 ? (
                  <HomePage showOrb={current === -1 && !taskView} mobile={mobile} />
                ) : (
                  ws && (
                    <WorkspacePage
                      ws={ws}
                      vw={vw}
                      vh={vh}
                      mobile={mobile}
                      taskView={taskView}
                      onStartDrag={startDrag}
                    />
                  )
                )}
                <AnimatePresence>
                  {taskView && (
                    <motion.p
                      className="heading-display pointer-events-none absolute inset-x-0 text-center text-[2.6rem] text-ink"
                      style={{ top: vh + 28 }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      {label(p.index)}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
          <AnimatePresence>
            {taskView && (
              <motion.button
                key="new-ws"
                type="button"
                data-page="new"
                className="pointer-events-auto absolute top-0 grid place-items-center rounded-[40px] border-[3px] border-dashed border-[var(--hairline-strong)] text-ink-2 transition hover:border-accent hover:text-accent-ink"
                style={{ left: pages.length * pageW, width: vw, height: vh }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => useWM.getState().addWorkspace()}
                aria-label="New workspace"
              >
                <span data-page="new" className="flex flex-col items-center gap-4">
                  <Plus className="size-20" strokeWidth={1.25} />
                  <span className="heading-display text-[2.6rem]">New workspace</span>
                </span>
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
      {drag?.moved && (
        <div
          className="glass pointer-events-none fixed z-[60] flex h-11 items-center gap-2 rounded-full px-4 text-sm text-ink"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {(() => {
            const app = APPS[windows[drag.winId]?.appId ?? ""];
            if (!app) return null;
            const Icon = app.icon;
            return (
              <>
                <Icon className="size-4 text-accent-ink" strokeWidth={1.5} />
                Move {app.name}
              </>
            );
          })()}
        </div>
      )}
    </>
  );
}
