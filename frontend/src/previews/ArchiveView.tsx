import { useEffect, useState } from "react";
import { fsApi } from "../apps/files/api";
import { toastError } from "../lib/toasts";
import type { PreviewProps } from "./index";
import { ErrorBox, Loading, formatBytes } from "./common";

type Data = Awaited<ReturnType<typeof fsApi.archive>>;

export default function ArchiveView({ entry, compact }: PreviewProps) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fsApi
      .archive(entry.path)
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (!live) return;
        setError((e as Error).message || "Couldn't read this archive.");
        toastError("Couldn't read archive", e);
      });
    return () => {
      live = false;
    };
  }, [entry.path]);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const rows = compact ? data.entries.slice(0, 50) : data.entries;
  return (
    <div className="flex h-full w-full flex-col text-sm">
      <p className="num shrink-0 px-4 py-2 text-xs text-ink-2">
        {data.format} · {data.entries.length}
        {data.truncated ? "+" : ""} items
      </p>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-[var(--surface-solid)] text-left text-xs text-ink-2">
            <tr>
              <th className="px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 text-right font-medium">Size</th>
              {!compact && <th className="px-2 py-1 font-medium">Modified</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-[var(--hairline)]">
                <td className="max-w-0 truncate px-2 py-1 text-ink" title={r.name}>
                  {r.name}
                </td>
                <td className="num whitespace-nowrap px-2 py-1 text-right text-ink-2">
                  {r.type === "dir" ? "—" : formatBytes(r.size)}
                </td>
                {!compact && (
                  <td className="num whitespace-nowrap px-2 py-1 text-ink-2">
                    {r.mtime ? new Date(r.mtime * 1000).toLocaleString() : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data.truncated && (
          <p className="px-2 py-2 text-xs text-ink-2">
            Truncated: only the first {data.entries.length} entries are shown.
          </p>
        )}
      </div>
    </div>
  );
}
