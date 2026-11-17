import { motion } from "framer-motion";
import { ArrowLeftRight, Columns2, LayoutPanelLeft, PictureInPicture2, Rows2, X } from "lucide-react";
import { Suspense, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { spring } from "../components/motion";
import { APPS, AppPlaceholder } from "./apps";
import { MIN_H, MIN_W, toFloatRect, type Box } from "./geometry";
import { useWM, type Win, type Workspace } from "./wm";

interface Props {
  win: Win;
  ws: Workspace;
  box: Box;
  area: Box;
  focused: boolean;
  taskView: boolean;
  mobile: boolean;
  onTitlebar?: (el: HTMLElement | null) => void;
  onStartDrag?: (winId: string, e: RPointerEvent) => void;
  extraTitle?: ReactNode;
}

const SNAP_PX = 24;

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="grid size-8 place-items-center rounded-full text-ink-2 transition hover:bg-[var(--hairline)] hover:text-ink"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function Window({
  win,
  ws,
  box,
  area,
  focused,
  taskView,
  mobile,
  onTitlebar,
  onStartDrag,
  extraTitle,
}: Props) {
  const app = APPS[win.appId]!;
  const Icon = app.icon;
  const wm = useWM.getState;
  const floating = ws.layout === "floating" && !mobile;
  const [live, setLive] = useState<Box | null>(null); // during drag/resize
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; start: Box } | null>(null);
  const shown = live ?? box;

  const beginPointer = (mode: "move" | "resize") => (e: RPointerEvent) => {
    if (!floating || taskView || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: box };
    wm().focusWindow(win.id);
  };
  const movePointer = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move")
      setLive({ ...d.start, x: d.start.x + dx, y: Math.max(area.y - 8, d.start.y + dy) });
    else setLive({ ...d.start, w: Math.max(MIN_W, d.start.w + dx), h: Math.max(MIN_H, d.start.h + dy) });
  };
  const endPointer = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !live) return setLive(null);
    const page = (e.currentTarget as HTMLElement).closest("[data-page]")!.getBoundingClientRect();
    const atStart = e.clientX <= page.left + SNAP_PX;
    if (d.mode === "move" && (atStart || e.clientX >= page.right - SNAP_PX)) {
      wm().snapToTile(ws.id, win.id, atStart ? "start" : "end");
    } else {
      wm().setFloat(ws.id, win.id, toFloatRect(area, live));
    }
    setLive(null);
  };

  const Body = app.component;
  return (
    <motion.section
      className="window absolute flex flex-col overflow-hidden rounded-[24px]"
      style={{ zIndex: focused ? 2 : 1 }}
      initial={{ opacity: 0, scale: 0.96, left: box.x, top: box.y, width: box.w, height: box.h }}
      animate={{ opacity: 1, scale: 1, left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={live ? { duration: 0 } : spring}
      onPointerDownCapture={() => !taskView && !focused && wm().focusWindow(win.id)}
      aria-label={app.name}
      data-window={win.id}
    >
      <header
        ref={onTitlebar}
        data-swipe
        className={`flex h-12 shrink-0 items-center gap-2 pr-2 pl-4 select-none ${floating ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={beginPointer("move")}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={() => !mobile && wm().setLayout(ws.id, floating ? "tiled" : "floating")}
      >
        <Icon className={`size-4 shrink-0 ${focused ? "text-accent-ink" : "text-ink-2"}`} strokeWidth={1.5} />
        <h2 className="heading-display min-w-0 flex-1 truncate text-[17px] text-ink">{app.name}</h2>
        {extraTitle}
        {!mobile && ws.windows.length === 2 && !floating && (
          <>
            <IconButton label="Swap sides" onClick={() => wm().swapWindows(ws.id)}>
              <ArrowLeftRight className="size-4" strokeWidth={1.5} />
            </IconButton>
            <IconButton
              label={ws.split === "row" ? "Stack vertically" : "Side by side"}
              onClick={() => wm().toggleSplit(ws.id)}
            >
              {ws.split === "row" ? (
                <Rows2 className="size-4" strokeWidth={1.5} />
              ) : (
                <Columns2 className="size-4" strokeWidth={1.5} />
              )}
            </IconButton>
          </>
        )}
        {!mobile && (
          <IconButton
            label={floating ? "Tile this workspace" : "Float this workspace"}
            onClick={() => wm().setLayout(ws.id, floating ? "tiled" : "floating")}
          >
            {floating ? (
              <LayoutPanelLeft className="size-4" strokeWidth={1.5} />
            ) : (
              <PictureInPicture2 className="size-4" strokeWidth={1.5} />
            )}
          </IconButton>
        )}
        <IconButton label={`Close ${app.name}`} onClick={() => wm().closeWindow(win.id)}>
          <X className="size-4" strokeWidth={1.5} />
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1 overflow-auto" inert={taskView}>
        {Body ? (
          <Suspense fallback={null}>
            <Body windowId={win.id} />
          </Suspense>
        ) : (
          <AppPlaceholder app={app} />
        )}
      </div>
      {floating && !taskView && (
        <div
          className="absolute right-0 bottom-0 size-5 cursor-nwse-resize"
          onPointerDown={beginPointer("resize")}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          aria-hidden
        />
      )}
      {taskView && (
        <div
          className="group absolute inset-0 z-10 cursor-pointer rounded-[24px] ring-0 transition hover:ring-[6px] hover:ring-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
          onPointerDown={(e) => onStartDrag?.(win.id, e)}
          aria-label={`Focus ${app.name}`}
        >
          <div className="pointer-events-none absolute inset-x-0 -top-16 flex justify-center opacity-0 transition group-hover:opacity-100">
            <span className="glass heading-display rounded-full px-6 py-2 text-3xl text-ink">{app.name}</span>
          </div>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              wm().closeWindow(win.id);
            }}
            className="glass absolute -top-5 -right-5 grid size-14 place-items-center rounded-full text-ink opacity-0 transition group-hover:opacity-100"
            aria-label={`Close ${app.name}`}
          >
            <X className="size-7" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </motion.section>
  );
}
