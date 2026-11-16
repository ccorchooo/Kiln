import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { spring } from "./motion";

function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 5);
    };
    timer = window.setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 5);
    return () => window.clearTimeout(timer);
  }, [intervalMs]);
  return now;
}

export function ClockPill({ showSeconds = false }: { showSeconds?: boolean }) {
  const now = useNow(showSeconds ? 1000 : 10_000);
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
  });
  const date = now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return (
    <motion.div
      layoutId="widget-clock"
      transition={spring}
      className="glass flex h-12 shrink-0 items-center gap-3 rounded-full px-5"
      role="timer"
      aria-label={`${time}, ${date}`}
    >
      <span className="num text-[15px] text-ink">{time}</span>
      <span className="text-sm text-ink-2">{date}</span>
    </motion.div>
  );
}
