import { motion } from "framer-motion";
import { spring } from "./motion";
import { useAuth, useUI, type OrbMood } from "../lib/store";
import { OrbAnchor } from "../three/OrbAnchor";

const MOOD_LABEL: Record<OrbMood, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  approval: "Needs you",
  error: "Offline",
};

/** AI status widget. When an app owns the screen, the orb shrinks into this pill. */
export function AiPill({ withOrb, onClick }: { withOrb: boolean; onClick?: () => void }) {
  const name = useAuth((s) => s.assistantName);
  const mood = useUI((s) => s.orbMood);
  const Tag = onClick ? motion.button : motion.div;
  return (
    <Tag
      layoutId="widget-ai"
      transition={spring}
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`glass hover-lift flex h-12 shrink-0 items-center gap-2.5 rounded-full pr-5 ${withOrb ? "pl-2" : "pl-5"}`}
      aria-label={`${name}: ${MOOD_LABEL[mood]}`}
    >
      {withOrb && <OrbAnchor className="size-9" />}
      <span className="text-[15px] font-medium text-ink">{name}</span>
      <span className={`text-sm ${mood === "approval" ? "text-warn-ink" : "text-ink-2"}`}>
        {MOOD_LABEL[mood]}
      </span>
    </Tag>
  );
}
