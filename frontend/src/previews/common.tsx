import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-ink-2" role="status">
      <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
      {label}
    </div>
  );
}

export function ErrorBox({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertCircle className="size-6 text-[var(--danger-ink)]" strokeWidth={1.5} />
      <p className="max-w-sm text-sm text-ink-2">{message}</p>
      {children}
    </div>
  );
}

/** Folder of a display path: "~/a/b.md" -> "~/a". */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "~" : path.slice(0, i);
}

/** Resolve a relative reference against a folder, collapsing "." and "..". */
export function resolveRelative(dir: string, rel: string): string {
  const parts = dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
