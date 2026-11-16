import type { Transition } from "framer-motion";

/** Shared springs: calm, physical, no loud bounce. */
export const spring: Transition = { type: "spring", stiffness: 280, damping: 30, mass: 1 };
export const springSoft: Transition = { type: "spring", stiffness: 260, damping: 32 };
export const fade: Transition = { duration: 0.3, ease: [0.22, 1, 0.36, 1] };
