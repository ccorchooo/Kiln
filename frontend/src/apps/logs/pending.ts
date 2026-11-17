import { useWM } from "../../shell/wm";

export interface LogFilter {
  unit: string;
  user: boolean;
  priority: string;
  grep: string;
  since: string;
}

export const EMPTY_FILTER: LogFilter = { unit: "", user: false, priority: "", grep: "", since: "" };

/** Filter for the next Logs window ("Logs" on a service). */
let pending: Partial<LogFilter> | null = null;
export function takePendingFilter(): Partial<LogFilter> | null {
  const p = pending;
  pending = null;
  return p;
}

export function openLogs(filter: Partial<LogFilter>): void {
  pending = filter;
  useWM.getState().openApp("logs");
}
