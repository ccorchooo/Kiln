import { Music } from "lucide-react";
import { rawUrl } from "../apps/files/api";
import type { PreviewProps } from "./index";

export default function MediaView({ entry, compact, audio }: PreviewProps & { audio?: boolean }) {
  const src = rawUrl(entry.path);
  if (audio) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-[20px] bg-accent-soft p-5 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-accent-fill text-on-accent">
            <Music className="size-6" strokeWidth={1.5} />
          </div>
          <p className="heading-display max-w-full truncate text-lg text-ink">{entry.name}</p>
          <audio src={src} controls preload="metadata" className="w-full" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-black/5">
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        className={`h-full w-full object-contain ${compact ? "rounded-[12px]" : ""}`}
      />
    </div>
  );
}
