import { create } from "zustand";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  at?: number;
  tone: ToastTone;
  title: string;
  message?: string;
  details?: string;
}

interface ToastStore {
  toasts: Toast[];
  /** Notification center history (newest first) and unread count. */
  history: Toast[];
  unread: number;
  markRead: () => void;
  clearHistory: () => void;
  push: (t: Omit<Toast, "id">, ttlMs?: number) => number;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  history: [],
  unread: 0,
  markRead: () => set({ unread: 0 }),
  clearHistory: () => set({ history: [], unread: 0 }),
  push: (t, ttlMs) => {
    const id = next++;
    const toast = { ...t, id, at: Date.now() };
    set({
      toasts: [...get().toasts.slice(-3), toast],
      history: [toast, ...get().history].slice(0, 100),
      unread: get().unread + 1,
    });
    const ttl = ttlMs ?? (t.tone === "error" ? 12000 : 5000);
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function toastError(title: string, err: unknown): void {
  const e = err as { message?: string; code?: string; status?: number; body?: unknown };
  useToasts.getState().push({
    tone: "error",
    title,
    message: e?.message ?? String(err),
    details: JSON.stringify({ status: e?.status, code: e?.code, body: e?.body }, null, 2),
  });
}
