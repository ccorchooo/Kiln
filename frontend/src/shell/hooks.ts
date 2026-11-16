import { useEffect, useState, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export const useIsMobile = () => useMediaQuery("(max-width: 767px)");

export function useViewport(): { vw: number; vh: number } {
  const [size, setSize] = useState(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ vw: window.innerWidth, vh: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/**
 * Horizontal swipe → workspace step. Touch swipes (one finger) and trackpad horizontal
 * scrolling (three-finger / two-finger swipe arrives as wheel deltaX).
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  onStep: (delta: number) => void,
  accept: (target: EventTarget | null) => boolean = () => true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let acc = 0;
    let lastWheel = 0;
    let cooldownUntil = 0;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !accept(e.target)) return;
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) onStep(dx < 0 ? 1 : -1);
    };
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !accept(e.target)) return;
      const now = performance.now();
      if (now < cooldownUntil) return;
      if (now - lastWheel > 250) acc = 0;
      lastWheel = now;
      acc += e.deltaX;
      if (Math.abs(acc) > 160) {
        onStep(acc > 0 ? 1 : -1);
        acc = 0;
        cooldownUntil = now + 550;
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", () => (tracking = false));
    el.addEventListener("wheel", wheel, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [ref, onStep, accept]);
}
