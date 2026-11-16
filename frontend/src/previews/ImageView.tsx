import { useCallback, useEffect, useRef, useState } from "react";
import { rawUrl } from "../apps/files/api";
import type { PreviewProps } from "./index";
import { ErrorBox, Loading } from "./common";

interface View {
  s: number;
  x: number;
  y: number;
}
const RESET: View = { s: 1, x: 0, y: 0 };

export default function ImageView({ entry, compact }: PreviewProps) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<View>(RESET);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);

  useEffect(() => {
    setState("loading");
    setView(RESET);
  }, [entry.path]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const s = Math.min(16, Math.max(0.2, v.s * factor));
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || compact) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(
        Math.exp(-e.deltaY * 0.0015),
        e.clientX - r.left - r.width / 2,
        e.clientY - r.top - r.height / 2,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [compact, zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (compact) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch.current) {
        const r = e.currentTarget.getBoundingClientRect();
        zoomAt(
          d / pinch.current,
          (a!.x + b!.x) / 2 - r.left - r.width / 2,
          (a!.y + b!.y) / 2 - r.top - r.height / 2,
        );
      }
      pinch.current = d;
    } else {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = 0;
  };

  return (
    <div
      ref={box}
      className={`relative h-full w-full overflow-hidden ${compact ? "" : "cursor-grab touch-none active:cursor-grabbing"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setView(RESET)}
    >
      {state === "loading" && (
        <div className="absolute inset-0">
          <Loading />
        </div>
      )}
      {state === "error" ? (
        <ErrorBox message="This image couldn't be loaded." />
      ) : (
        <img
          src={rawUrl(entry.path)}
          alt={entry.name}
          draggable={false}
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          className="h-full w-full select-none object-contain"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            opacity: state === "ready" ? 1 : 0,
          }}
        />
      )}
    </div>
  );
}
