/**
 * Single Monaco setup shared by the Editor app and the code preview.
 * Workers are bundled by Vite (no CDN); themes come from the Clay palette.
 */
import * as monaco from "monaco-editor";
import "@fontsource/geist-mono/400.css";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import type { Mode } from "../../theme/themes";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

function define(name: string, base: "vs" | "vs-dark", c: Record<string, string>, rules: [string, string][]) {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: rules.map(([token, fg]) => ({ token, foreground: fg.replace("#", "") })),
    colors: c,
  });
}

let defined = false;
export function ensureThemes(): void {
  if (defined) return;
  defined = true;
  define(
    "kiln-light",
    "vs",
    {
      "editor.background": "#FBF8F2",
      "editor.foreground": "#2A2622",
      "editorLineNumber.foreground": "#B8AEA0",
      "editorLineNumber.activeForeground": "#6B645B",
      "editor.selectionBackground": "#C9644238",
      "editor.inactiveSelectionBackground": "#C9644222",
      "editor.lineHighlightBackground": "#F2EBDF",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#C96442",
      "editorIndentGuide.background1": "#E7DFD1",
      "editorIndentGuide.activeBackground1": "#CFC4B2",
      "editorWidget.background": "#F5F0E8",
      "editorWidget.border": "#E0D6C6",
      "editorSuggestWidget.background": "#F5F0E8",
      "editorSuggestWidget.selectedBackground": "#F0D9CC",
      "scrollbarSlider.background": "#6B645B22",
      "scrollbarSlider.hoverBackground": "#6B645B44",
      "diffEditor.insertedTextBackground": "#6E8B5E2E",
      "diffEditor.removedTextBackground": "#B5533C2A",
      "diffEditor.insertedLineBackground": "#6E8B5E18",
      "diffEditor.removedLineBackground": "#B5533C14",
    },
    [
      ["comment", "#9A9084"],
      ["keyword", "#A8472B"],
      ["string", "#5E7A4E"],
      ["number", "#A87E25"],
      ["type", "#4F6A8A"],
      ["delimiter", "#7A7167"],
      ["tag", "#A8472B"],
      ["attribute.name", "#8E5A7A"],
      ["attribute.value", "#5E7A4E"],
      ["regexp", "#4E7F7A"],
    ],
  );
  define(
    "kiln-dark",
    "vs-dark",
    {
      "editor.background": "#1F1B18",
      "editor.foreground": "#EEE7DC",
      "editorLineNumber.foreground": "#5E574F",
      "editorLineNumber.activeForeground": "#A89E91",
      "editor.selectionBackground": "#D977574D",
      "editor.inactiveSelectionBackground": "#D9775730",
      "editor.lineHighlightBackground": "#2A2622",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#D97757",
      "editorIndentGuide.background1": "#35302B",
      "editorIndentGuide.activeBackground1": "#4A433C",
      "editorWidget.background": "#2A2622",
      "editorWidget.border": "#3D3731",
      "editorSuggestWidget.background": "#2A2622",
      "editorSuggestWidget.selectedBackground": "#4A3127",
      "scrollbarSlider.background": "#EEE7DC22",
      "scrollbarSlider.hoverBackground": "#EEE7DC44",
      "diffEditor.insertedTextBackground": "#8AA77A33",
      "diffEditor.removedTextBackground": "#CF6F5733",
      "diffEditor.insertedLineBackground": "#8AA77A1A",
      "diffEditor.removedLineBackground": "#CF6F5717",
    },
    [
      ["comment", "#7E7569"],
      ["keyword", "#E0826A"],
      ["string", "#9DB88E"],
      ["number", "#DDB866"],
      ["type", "#8FA8C8"],
      ["delimiter", "#A89E91"],
      ["tag", "#E0826A"],
      ["attribute.name", "#C69AB4"],
      ["attribute.value", "#9DB88E"],
      ["regexp", "#8CC2BA"],
    ],
  );
}

export const monacoTheme = (mode: Mode): string => (mode === "dark" ? "kiln-dark" : "kiln-light");

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: '"Geist Mono", ui-monospace, monospace',
  fontSize: 13.5,
  fontLigatures: false,
  cursorSmoothCaretAnimation: "on",
  minimap: { enabled: false },
  roundedSelection: true,
  padding: { top: 12, bottom: 12 },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  smoothScrolling: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  lua: "lua",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  nix: "plaintext",
  txt: "plaintext",
  log: "plaintext",
  csv: "plaintext",
};

export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : lower;
  return EXT_LANG[ext] ?? "plaintext";
}

export { monaco };
