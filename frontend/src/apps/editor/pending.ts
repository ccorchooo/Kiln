/** Hand-off of a file path to the Editor app (from Files, terminal links, Ember). */
import { create } from "zustand";
import { useWM } from "../../shell/wm";

export const useEditorQueue = create<{ queue: string[]; take: () => string[] }>((set, get) => ({
  queue: [],
  take: () => {
    const q = get().queue;
    if (q.length) set({ queue: [] });
    return q;
  },
}));

export function openInEditor(path: string): void {
  useEditorQueue.setState((s) => ({ queue: [...s.queue, path] }));
  useWM.getState().openApp("editor");
}
