import { useWM } from "../../shell/wm";
import { setPendingCommand, setPendingCwd } from "./prefs";

/** Open a new terminal (paired next to the current app when possible) starting in `path`. */
export function openTerminalAt(path: string): void {
  setPendingCwd(path);
  useWM.getState().openApp("terminal");
}

/** Open a new terminal and run `command` in it (e.g. a package install that needs sudo). */
export function openTerminalWith(command: string): void {
  setPendingCommand(command);
  useWM.getState().openApp("terminal");
}
