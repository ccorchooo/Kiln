/**
 * Marks where the single shared orb should be. The WebGL scene reads the active anchor's rect
 * every frame (so the orb follows anchors that slide, scale or reflow) and springs toward it.
 * The active anchor is the one with the highest `priority`, then the most recently mounted:
 * the lock screen outranks a desktop that is still fading out behind it.
 * With quality "off" a CSS blob is rendered here instead and glides via layoutId.
 */
import { motion } from "framer-motion";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useUI } from "../lib/store";

interface Props {
  className?: string;
  label?: string;
  onActivate?: () => void;
  priority?: number;
  children?: ReactNode;
}

interface Entry {
  el: HTMLElement;
  priority: number;
  seq: number;
}

const anchors = new Set<Entry>();
let seq = 0;

/** The orb's target in CSS px (center + diameter), or null when no anchor is showing. */
export function readOrbAnchor(): { cx: number; cy: number; size: number } | null {
  let best: Entry | null = null;
  for (const a of anchors)
    if (!best || a.priority > best.priority || (a.priority === best.priority && a.seq > best.seq)) best = a;
  if (!best) return null;
  const r = best.el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: Math.min(r.width, r.height) };
}

export function OrbAnchor({ className = "", label, onActivate, priority = 0, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const quality = useUI((s) => s.quality);

  useLayoutEffect(() => {
    const entry = { el: ref.current!, priority, seq: ++seq };
    anchors.add(entry);
    return () => void anchors.delete(entry);
  }, [priority]);

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
