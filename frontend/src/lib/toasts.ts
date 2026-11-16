import { create } from "zustand";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  details?: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ttlMs?: number) => number;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t, ttlMs) => {
    const id = next++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
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
