import { useEffect, useRef, useState } from "react";
import { fsApi } from "../apps/files/api";
import { EDITOR_OPTIONS, ensureThemes, languageFor, monaco, monacoTheme } from "../apps/editor/monaco";
import { useUI } from "../lib/store";
import { toastError } from "../lib/toasts";
import type { PreviewProps } from "./index";
import OtherView from "./OtherView";
import { ErrorBox, Loading } from "./common";

const MAX_CHARS = 2 * 1024 * 1024;

export default function CodeView({ entry, compact }: PreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const mode = useUI((s) => s.mode);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<{ binary: boolean; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    fsApi
      .readText(entry.path)
      .then((t) => live && setText(t.content))
      .catch((e: unknown) => {
        if (!live) return;
        const err = e as { code?: string; message?: string };
        setError({ binary: err.code === "binary", message: err.message ?? "Couldn't read this file." });
        if (err.code !== "binary") toastError("Couldn't load file", e);
      });
    return () => {
      live = false;
    };
  }, [entry.path]);

  const truncated = text !== null && text.length > MAX_CHARS;

  useEffect(() => {
    if (text === null || !host.current) return;
    ensureThemes();
    const ed = monaco.editor.create(host.current, {
      ...EDITOR_OPTIONS,
      value: truncated ? text.slice(0, MAX_CHARS) : text,
      language: languageFor(entry.name),
      theme: monacoTheme(useUI.getState().mode),
      readOnly: true,
      domReadOnly: true,
      lineNumbers: compact ? "off" : "on",
      folding: !compact,
      padding: { top: compact ? 8 : 12, bottom: 12 },
      fontSize: compact ? 12 : EDITOR_OPTIONS.fontSize,
    });
    return () => {
      const model = ed.getModel();
      ed.dispose();
      model?.dispose();
    };
  }, [text, truncated, entry.name, compact]);

  useEffect(() => {
    ensureThemes();
    monaco.editor.setTheme(monacoTheme(mode));
  }, [mode]);

  if (error) return error.binary ? <OtherView entry={entry} /> : <ErrorBox message={error.message} />;
  if (text === null) return <Loading />;
  return (
    <div className="flex h-full w-full flex-col">
      {truncated && (
        <p className="shrink-0 bg-accent-soft px-3 py-1.5 text-xs text-accent-ink">
          Showing the first 2 MB of this file.
        </p>
      )}
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}
