import { motion } from "framer-motion";
import { useMemo } from "react";
import { fade } from "../components/motion";
import { OrbAnchor } from "../three/OrbAnchor";
import { useWidgets } from "../widgets/store";
import { Widget } from "../widgets/Widget";
import { PasswordPill } from "./PasswordPill";

/**
 * Lock / sign-in screen. Orb large at left-center; one row of frosted pills along the
 * bottom-left: password first, then the widgets marked "show on lock screen".
 * Widgets here must never show sensitive content.
 */
export function LockScreen() {
  const all = useWidgets((s) => s.widgets);
  const widgets = useMemo(() => all.filter((w) => w.lock), [all]);
  return (
    <motion.main
      className="fixed inset-0 z-10"
      initial={{ opacity: 1 }}
      exit={{ opacity: 1, transition: fade }}
      aria-label="Kiln is locked"
    >
      <OrbAnchor
        className="absolute top-[34%] left-1/2 aspect-square w-[min(56vw,34vh)] -translate-x-1/2 -translate-y-1/2 md:top-1/2 md:left-[clamp(40px,10vw,180px)] md:w-[min(40vh,32vw)] md:translate-x-0 md:-translate-y-[55%]"
        label="Ember"
      />
      <div className="absolute inset-x-4 bottom-[max(16px,env(safe-area-inset-bottom))] flex flex-col items-stretch gap-3 md:inset-x-auto md:bottom-6 md:left-6 md:flex-row md:items-center">
        <PasswordPill />
        <div className="flex flex-wrap justify-center gap-3 md:contents">
          {widgets.map((w) => (
            <Widget key={w.id} w={w} interactive={false} />
          ))}
        </div>
      </div>
    </motion.main>
  );
}
