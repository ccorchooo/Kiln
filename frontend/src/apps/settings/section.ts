import { create } from "zustand";
import { useWM } from "../../shell/wm";

export type SettingsSection = "appearance" | "dock" | "sessions" | "security";

export const useSettingsSection = create<{ section: SettingsSection; set: (s: SettingsSection) => void }>(
  (set) => ({
    section: "appearance",
    set: (section) => set({ section }),
  }),
);

export function openSettings(section: SettingsSection): void {
  useSettingsSection.getState().set(section);
  useWM.getState().openApp("settings");
}
