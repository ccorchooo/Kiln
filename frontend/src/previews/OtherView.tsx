import { FileQuestion } from "lucide-react";
import type { PreviewProps } from "./index";
import { formatBytes } from "./common";

export default function OtherView({ entry, note }: PreviewProps & { note?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FileQuestion className="size-16 text-ink-2" strokeWidth={1.25} />
      <p className="heading-display max-w-full truncate text-lg text-ink">{entry.name}</p>
      <p className="num text-xs text-ink-2">
        {formatBytes(entry.size)} · {entry.mime ?? "unknown type"}
      </p>
      <p className="text-sm text-ink-2">{note ?? "No preview for this file type"}</p>
    </div>
  );
}
