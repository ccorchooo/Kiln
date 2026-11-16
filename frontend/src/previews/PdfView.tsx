import { Minus, Plus } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { rawUrl } from "../apps/files/api";
import { toastError } from "../lib/toasts";
import type { PreviewProps } from "./index";
import { ErrorBox, Loading } from "./common";

// pdf.js 6 has no eval path (isEvalSupported was removed), so it fits the CSP. Module worker bundled by Vite (served from 'self'); no CDN.
if (!pdfjs.GlobalWorkerOptions.workerPort) {
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(
    new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module" },
  );
}

function PageCanvas({
  doc,
  n,
  scale,
  eager,
  size,
}: {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  eager: boolean;
  size: { w: number; h: number };
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (eager) return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), {
      rootMargin: "600px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  useEffect(() => {
    const cv = canvas.current;
    if (!visible || !cv) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let dead = false;
    doc
      .getPage(n)
      .then((page) => {
        if (dead) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * dpr });
        cv.width = Math.floor(vp.width);
        cv.height = Math.floor(vp.height);
        task = page.render({ canvas: cv, viewport: vp });
        return task.promise;
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name !== "RenderingCancelledException" && !dead) {
          toastError("Couldn't render PDF page", e);
        }
      });
    return () => {
      dead = true;
      task?.cancel();
    };
  }, [visible, doc, n, scale]);

  return (
    <div
      ref={holder}
      className="mx-auto my-3 rounded-[4px] bg-white shadow-sm"
      style={{ width: size.w * scale, height: size.h * scale }}
    >
      {visible && <canvas ref={canvas} className="block h-full w-full" />}
    </div>
  );
}

export default function PdfView({ entry, compact }: PreviewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 612, h: 792 });
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    const loading = pdfjs.getDocument({ url: rawUrl(entry.path) });
    let dead = false;
    loading.promise
      .then(async (d) => {
        const p = await d.getPage(1);
        const vp = p.getViewport({ scale: 1 });
        if (dead) return;
        setSize({ w: vp.width, h: vp.height });
        setDoc(d);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setError((e as Error).message || "Couldn't open this PDF.");
        toastError("Couldn't open PDF", e);
      });
    return () => {
      dead = true;
      loading.destroy().catch(() => undefined);
    };
  }, [entry.path]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const avail = el.clientWidth - 24;
      if (avail > 0) setFit(Math.min(avail / size.w, compact ? 2 : 1.6));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.w, compact, doc]);

  if (error) return <ErrorBox message={error} />;
  if (!doc) return <Loading label="Opening PDF…" />;
  const scale = fit * zoom;
  const pages = compact ? 1 : doc.numPages;

  return (
    <div className="flex h-full w-full flex-col">
      {!compact && (
        <div className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-xs text-ink-2">
          <span className="num mr-auto">
            {doc.numPages} {doc.numPages === 1 ? "page" : "pages"}
          </span>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
            className="grid size-7 place-items-center rounded-full hover:bg-[var(--hairline)] hover:text-ink"
          >
            <Minus className="size-4" strokeWidth={1.5} />
          </button>
          <span className="num w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(4, z * 1.2))}
            className="grid size-7 place-items-center rounded-full hover:bg-[var(--hairline)] hover:text-ink"
          >
            <Plus className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      )}
      <div ref={box} className={`min-h-0 flex-1 ${compact ? "overflow-hidden" : "overflow-auto"}`}>
        {Array.from({ length: pages }, (_, i) => (
          <PageCanvas key={i} doc={doc} n={i + 1} scale={scale} eager={i === 0} size={size} />
        ))}
      </div>
    </div>
  );
}
