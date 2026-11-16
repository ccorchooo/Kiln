import "./prose.css";
import { useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fsApi, rawUrl } from "../apps/files/api";
import { toastError } from "../lib/toasts";
import type { PreviewProps } from "./index";
import OtherView from "./OtherView";
import { ErrorBox, Loading, dirname, resolveRelative } from "./common";

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/|#)/i;

export default function MarkdownView({ entry, compact }: PreviewProps) {
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
        if (err.code !== "binary") toastError("Couldn't load markdown", e);
      });
    return () => {
      live = false;
    };
  }, [entry.path]);

  if (error) return error.binary ? <OtherView entry={entry} /> : <ErrorBox message={error.message} />;
  if (text === null) return <Loading />;

  const dir = dirname(entry.path);
  const components: Components = {
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    img: ({ src, alt }) => {
      const s = typeof src === "string" ? src : "";
      const resolved =
        s && !ABSOLUTE.test(s) ? rawUrl(resolveRelative(dir, decodeURI(s.split(/[?#]/)[0]!))) : s;
      return <img src={resolved} alt={alt ?? ""} loading="lazy" />;
    },
  };

  return (
    <div className="h-full w-full overflow-auto">
      <article className={`kiln-prose mx-auto ${compact ? "p-3 text-xs" : "max-w-3xl p-6"}`}>
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {compact ? text.slice(0, 4000) : text}
        </Markdown>
      </article>
    </div>
  );
}
