/**
 * Widgets grouped into tinted islands by category. On the taskbar the row scrolls with the
 * normal mouse wheel when it doesn't fit, and fades at the clipped edge so overflow is visible.
 */
import { motion } from "framer-motion";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { spring } from "../components/motion";
import { CATEGORY_LABEL, groupWidgets, type WidgetConfig } from "./types";
import { Widget } from "./Widget";

interface Props {
  widgets: WidgetConfig[];
  interactive: boolean;
  withOrb?: boolean;
  placement?: "up" | "down";
  align?: "start" | "end";
  /** Taskbar: one scrollable row. Lock screen / phone sheet: wrap. */
  layout: "row" | "wrap";
  className?: string;
}

export function WidgetIslands({
  widgets,
  interactive,
  withOrb = false,
  placement = "up",
  align = "start",
  layout,
  className = "",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el || layout !== "row") return;
    const measure = () =>
      setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    [...el.children].forEach((c) => ro.observe(c));
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", wheel);
    };
  }, [layout, widgets]);

  const fade = 28;
  const mask =
    layout === "row" && (edges.left || edges.right)
      ? `linear-gradient(to right, ${edges.left ? "transparent" : "#000"} 0, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges.right ? "transparent" : "#000"} 100%)`
      : undefined;

  return (
    <div
      ref={ref}
      aria-label="Widgets"
      className={`flex items-center gap-3 ${layout === "row" ? "no-scrollbar min-w-0 overflow-x-auto py-2" : "flex-wrap justify-center"} ${className}`}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {groupWidgets(widgets).map(({ category, widgets: ws }) => (
        <motion.div
          key={category}
          layout
          transition={spring}
          role="group"
          aria-label={CATEGORY_LABEL[category]}
          data-category={category}
          className="widget-island glass flex h-12 shrink-0 items-center gap-0.5 rounded-full px-1"
          style={{ "--cat": `var(--cat-${category})` } as CSSProperties}
        >
          {ws.map((w) => (
            <Widget
              key={w.id}
              w={w}
              interactive={interactive}
              withOrb={withOrb}
              placement={placement}
              align={align}
              variant="segment"
            />
          ))}
        </motion.div>
      ))}
    </div>
  );
}
