import { create } from "zustand";
import type { Mode } from "../theme/themes";

export type AuthStatus = "loading" | "setup" | "signedOut" | "locked" | "unlocked";

export interface AuthState {
  status: AuthStatus;
  csrf: string | null;
  sessionId: string | null;
  displayName: string;
  assistantName: string;
  idleLockMinutes: number;
  totpEnabled: boolean;
}

export interface ServerAuthState {
  setup: boolean;
  authenticated: boolean;
  locked: boolean;
  idle_lock_minutes: number;
  csrf?: string;
  session_id?: string;
  totp_enabled?: boolean;
  display_name?: string;
  assistant_name?: string;
}

interface AuthStore extends AuthState {
  fromServer: (s: ServerAuthState) => void;
  setStatus: (status: AuthStatus) => void;
}

export const useAuth = create<AuthStore>((set) => ({
  status: "loading",
  csrf: null,
  sessionId: null,
  displayName: "",
  assistantName: "Ember",
  idleLockMinutes: 10,
  totpEnabled: false,
  fromServer: (s) =>
    set((prev) => ({
      status: !s.setup ? "setup" : !s.authenticated ? "signedOut" : s.locked ? "locked" : "unlocked",
      csrf: s.csrf ?? null,
      sessionId: s.session_id ?? null,
      idleLockMinutes: s.idle_lock_minutes,
      displayName: s.display_name ?? prev.displayName,
      assistantName: s.assistant_name ?? prev.assistantName,
      totpEnabled: s.totp_enabled ?? prev.totpEnabled,
    })),
  setStatus: (status) => set(status === "signedOut" ? { status, csrf: null, sessionId: null } : { status }),
}));

export type Quality = "high" | "balanced" | "low" | "off";
export type QualityPref = Quality | "auto";
export type OrbMood = "idle" | "listening" | "thinking" | "speaking" | "approval" | "error";

export interface OrbAnchor {
  owner: string;
  cx: number;
  cy: number;
  size: number;
}

interface UIStore {
  mode: Mode;
  themeId: string;
  modePreference: "auto" | "light" | "dark";
  qualityPref: QualityPref;
  quality: Quality; // effective
  reducedMotion: boolean;
  orbMood: OrbMood;
  orbAnchor: OrbAnchor | null;
  // Live audio drivers for the orb (0..1); written by the voice pipeline in Phase 7.
  audio: { level: number; bands: [number, number, number, number] };
  set: (patch: Partial<Omit<UIStore, "set">>) => void;
}

export const useUI = create<UIStore>((set) => ({
  mode: "dark",
  themeId: "clay",
  modePreference: "auto",
  qualityPref: "auto",
  quality: "high",
  reducedMotion: false,
  orbMood: "idle",
  orbAnchor: null,
  audio: { level: 0, bands: [0, 0, 0, 0] },
  set: (patch) => set(patch),
}));
