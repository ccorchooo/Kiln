import { api } from "./api";
import { useAuth, type ServerAuthState } from "./store";

export async function refreshAuth(): Promise<ServerAuthState> {
  const s = await api<ServerAuthState>("/api/auth/state");
  useAuth.getState().fromServer(s);
  return s;
}

export async function lockNow(): Promise<void> {
  useAuth.getState().setStatus("locked");
  try {
    await api("/api/auth/lock", { method: "POST" });
  } catch {
    /* the UI is locked regardless; server auto-lock is the backstop */
  }
}

export async function panicNow(): Promise<void> {
  useAuth.getState().setStatus("signedOut");
  try {
    await api("/api/auth/panic", { method: "POST" });
  } finally {
    await refreshAuth().catch(() => undefined);
  }
}
