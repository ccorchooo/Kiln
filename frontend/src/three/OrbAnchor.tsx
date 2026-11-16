/**
 * Marks where the single shared orb should be. The WebGL orb springs to the active anchor;
 * with quality "off" a CSS blob is rendered here instead and glides via layoutId.
 *
 * `untransformed`: measure the layout position (offsetLeft/Top chain) instead of the painted
 * rect, for anchors inside containers that are mid-animation (e.g. the workspace strip).
 */
import { motion } from "framer-motion";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useUI } from "../lib/store";

interface Props {
  className?: string;
  label?: string;
  onActivate?: () => void;
  untransformed?: boolean;
  children?: ReactNode;
}

function layoutRect(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node) {
    x += node.offsetLeft;
    y += node.offsetTop;
    if (node.dataset.orbOrigin !== undefined) break;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function OrbAnchor({ className = "", label, onActivate, untransformed = false, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const owner = useId();
  const quality = useUI((s) => s.quality);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => {
      const r = untransformed
        ? layoutRect(el)
        : (() => {
            const b = el.getBoundingClientRect();
            return { x: b.left, y: b.top, w: b.width, h: b.height };
          })();
      useUI.getState().set({
        orbAnchor: { owner, cx: r.x + r.w / 2, cy: r.y + r.h / 2, size: Math.min(r.w, r.h) },
      });
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, [owner, untransformed]);

  useEffect(
    () => () => {
      if (useUI.getState().orbAnchor?.owner === owner) useUI.getState().set({ orbAnchor: null });
    },
    [owner],
  );

  const Tag = onActivate ? "button" : "div";
  return (
    <div ref={ref} className={`relative ${className}`}>
      {quality === "off" && (
        <motion.div
          layoutId="kiln-orb"
          className="orb-fallback absolute inset-[7%]"
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
        />
      )}
      <Tag
        type={onActivate ? "button" : undefined}
        aria-label={label}
        onClick={onActivate}
        className="absolute inset-[10%] rounded-full"
      />
      {children}
    </div>
  );
}
