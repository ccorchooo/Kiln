import { useWM } from "../../shell/wm";
import { setPendingCwd } from "./prefs";

/** Open a new terminal (paired next to the current app when possible) starting in `path`. */
export function openTerminalAt(path: string): void {
  setPendingCwd(path);
  useWM.getState().openApp("terminal");
}
