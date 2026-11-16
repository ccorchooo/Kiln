/** File previews. Heavy viewers are lazy so the Files bundle stays light. */
import { lazy, Suspense } from "react";
import { kindOf, type Entry } from "../apps/files/api";
import { Loading } from "./common";
import OtherView from "./OtherView";

export interface PreviewProps {
  entry: Entry;
  compact?: boolean;
}

const ImageView = lazy(() => import("./ImageView"));
const MediaView = lazy(() => import("./MediaView"));
const ArchiveView = lazy(() => import("./ArchiveView"));
const PdfView = lazy(() => import("./PdfView"));
const MarkdownView = lazy(() => import("./MarkdownView"));
const CodeView = lazy(() => import("./CodeView"));
const ModelView = lazy(() => import("./ModelView"));

function pick({ entry, compact }: PreviewProps) {
  switch (kindOf(entry)) {
    case "image":
      return <ImageView entry={entry} compact={compact} />;
    case "video":
      return <MediaView entry={entry} compact={compact} />;
    case "audio":
      return <MediaView entry={entry} compact={compact} audio />;
    case "pdf":
      return <PdfView entry={entry} compact={compact} />;
    case "markdown":
      return <MarkdownView entry={entry} compact={compact} />;
    case "code":
    case "text":
      return <CodeView entry={entry} compact={compact} />;
    case "model":
      return <ModelView entry={entry} compact={compact} />;
    case "archive":
      return <ArchiveView entry={entry} compact={compact} />;
    default:
      return <OtherView entry={entry} compact={compact} />;
  }
}

export function Preview({ entry, compact }: PreviewProps) {
  return (
    <div className="h-full w-full">
      <Suspense fallback={<Loading />}>{pick({ entry, compact })}</Suspense>
    </div>
  );
}
