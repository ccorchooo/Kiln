/** Hand-off of a path to open in Files (from terminal links, Spotlight, Ember). Consumed in Phase 5. */
import { create } from "zustand";
import { useWM } from "../../shell/wm";

export const usePendingPath = create<{ path: string | null; take: () => string | null }>((set, get) => ({
  path: null,
  take: () => {
    const p = get().path;
    if (p !== null) set({ path: null });
    return p;
  },
}));

export function openInFiles(path: string): void {
  usePendingPath.setState({ path });
  useWM.getState().openApp("files");
}
