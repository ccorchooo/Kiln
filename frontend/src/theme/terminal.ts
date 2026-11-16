/** Warm ANSI palettes for xterm.js, one per mode (per theme later in Phase 9). */
import type { ITheme } from "@xterm/xterm";
import type { Mode } from "./themes";

const light: ITheme = {
  background: "#FBF8F2",
  foreground: "#2A2622",
  cursor: "#C96442",
  cursorAccent: "#FBF8F2",
  selectionBackground: "rgba(201, 100, 66, 0.22)",
  black: "#2A2622",
  red: "#B5533C",
  green: "#5E7A4E",
  yellow: "#A87E25",
  blue: "#4F6A8A",
  magenta: "#8E5A7A",
  cyan: "#4E7F7A",
  white: "#D9D2C7",
  brightBlack: "#8A8178",
  brightRed: "#C96442",
  brightGreen: "#6E8B5E",
  brightYellow: "#C89B3C",
  brightBlue: "#6683A6",
  brightMagenta: "#A8708F",
  brightCyan: "#5E958F",
  brightWhite: "#F5F0E8",
};

const dark: ITheme = {
  background: "#1F1B18",
  foreground: "#EEE7DC",
  cursor: "#D97757",
  cursorAccent: "#1F1B18",
  selectionBackground: "rgba(217, 119, 87, 0.30)",
  black: "#2A2622",
  red: "#E0826A",
  green: "#9DB88E",
  yellow: "#DDB866",
  blue: "#8FA8C8",
  magenta: "#C69AB4",
  cyan: "#8CC2BA",
  white: "#D9D2C7",
  brightBlack: "#6B645B",
  brightRed: "#F0A08A",
  brightGreen: "#B5CDA6",
  brightYellow: "#EBCB85",
  brightBlue: "#A9BFDB",
  brightMagenta: "#D9B2C8",
  brightCyan: "#A6D4CD",
  brightWhite: "#FFF8EE",
};

export function terminalTheme(_themeId: string, mode: Mode): ITheme {
  return mode === "dark" ? dark : light;
}
