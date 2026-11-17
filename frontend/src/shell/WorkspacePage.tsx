import { AnimatePresence, motion } from "framer-motion";
import { Repeat2 } from "lucide-react";
import { useState, type PointerEvent as RPointerEvent } from "react";
import { spring } from "../components/motion";
import { contentArea, floatBox, GAP, rubber, tiledBoxes, type Box } from "./geometry";
import { Window } from "./Window";
import { RATIO_MAX, RATIO_MIN, useWM, type Workspace } from "./wm";

interface Props {
  ws: Workspace;
  vw: number;
  vh: number;
  mobile: boolean;
  taskView: boolean;
  onStartDrag: (winId: string, e: RPointerEvent) => void;
  onTitlebar?: (el: HTMLElement | null) => void;
}

function Divider({ ws, area, taskView }: { ws: Workspace; area: Box; taskView: boolean }) {
  const [live, setLive] = useState<number | null>(null);
  const ratio = live ?? ws.ratio;
  const row = ws.split === "row";
  const [a] = tiledBoxes(area, 2, ws.split, ratio);
  const pos = row
    ? { left: a!.x + a!.w, top: area.y, width: GAP, height: area.h }
    : { left: area.x, top: a!.y + a!.h, width: area.w, height: GAP };

  const move = (e: RPointerEvent) => {
    if (live === null) return;
    const page = e.currentTarget.parentElement!.getBoundingClientRect(); // the desk may be inset
    const raw = row
      ? (e.clientX - page.left - area.x - GAP / 2) / (area.w - GAP)
      : (e.clientY - page.top - area.y - GAP / 2) / (area.h - GAP);
    setLive(rubber(raw, RATIO_MIN, RATIO_MAX));
  };
  const end = () => {
    if (live !== null) useWM.getState().setRatio(ws.id, live);
    setLive(null);
  };
  return (
    <motion.div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={RATIO_MIN * 100}
      aria-valuemax={RATIO_MAX * 100}
      aria-valuenow={Math.round(ws.ratio * 100)}
      aria-label="Resize split"
      tabIndex={taskView ? -1 : 0}
      className={`group absolute z-[3] grid place-items-center ${row ? "cursor-col-resize" : "cursor-row-resize"}`}
      initial={false}
      animate={pos}
      transition={live !== null ? { duration: 0 } : spring}
      onPointerDown={(e) => {
        if (taskView) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setLive(ws.ratio);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => useWM.getState().setRatio(ws.id, 0.5)}
      onKeyDown={(e) => {
        const step =
          e.key === (row ? "ArrowLeft" : "ArrowUp")
            ? -0.05
            : e.key === (row ? "ArrowRight" : "ArrowDown")
              ? 0.05
              : 0;
        if (step) {
          e.preventDefault();
          useWM.getState().setRatio(ws.id, ws.ratio + step);
        }
      }}
    >
      <span
        className={`rounded-full bg-[var(--hairline-strong)] transition group-hover:bg-accent group-focus-visible:bg-accent ${row ? "h-12 w-1" : "h-1 w-12"} ${live !== null ? "bg-accent" : ""}`}
      />
    </motion.div>
  );
}

export function WorkspacePage({ ws, vw, vh, mobile, taskView, onStartDrag, onTitlebar }: Props) {
  const windows = useWM((s) => s.windows);
  const area = contentArea(vw, vh, mobile);
  const ids = ws.windows.filter((id) => windows[id]);
  const floating = ws.layout === "floating" && !mobile;

  // Mobile: one app at a time; a chip flips between the pair.
  const visible = mobile
    ? ([ws.focused && ids.includes(ws.focused) ? ws.focused : ids[0]].filter(Boolean) as string[])
    : ids;
  const boxes = floating
    ? visible.map((id, i) =>
        floatBox(area, ws.float[id] ?? { x: 0.08 + i * 0.06, y: 0.06 + i * 0.06, w: 0.56, h: 0.72 }),
      )
    : tiledBoxes(area, visible.length, ws.split, ws.ratio);

  return (
    <>
      <AnimatePresence>
        {visible.map((id, i) => (
          <Window
            key={id}
            win={windows[id]!}
            ws={ws}
            box={boxes[i]!}
            area={area}
            focused={ws.focused === id}
            taskView={taskView}
            mobile={mobile}
            onStartDrag={onStartDrag}
            onTitlebar={onTitlebar}
            extraTitle={
              mobile && ids.length === 2 ? (
                <button
                  type="button"
                  onClick={() => useWM.getState().focusWindow(ids.find((o) => o !== id)!)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="grid size-8 place-items-center rounded-full text-ink-2"
                  aria-label="Switch to the other app on this workspace"
                >
                  <Repeat2 className="size-4" strokeWidth={1.5} />
                </button>
              ) : undefined
            }
          />
        ))}
      </AnimatePresence>
      {!floating && visible.length === 2 && <Divider ws={ws} area={area} taskView={taskView} />}
    </>
  );
}
