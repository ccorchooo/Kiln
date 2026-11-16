/**
 * Marks where the single shared orb should be. The WebGL orb springs to the active anchor's
 * rect; with quality "off" a CSS blob is rendered here instead and glides via layoutId.
 */
import { motion } from "framer-motion";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useUI } from "../lib/store";

interface Props {
  className?: string;
  label?: string;
  onActivate?: () => void;
  children?: ReactNode;
}

export function OrbAnchor({ className = "", label, onActivate, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const owner = useId();
  const quality = useUI((s) => s.quality);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => {
      const r = el.getBoundingClientRect();
      useUI.getState().set({
        orbAnchor: {
          owner,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          size: Math.min(r.width, r.height),
        },
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
  }, [owner]);

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
