/** Chunked, resumable uploads (4 MiB chunks; resumes from the server's received offset). */
import { create } from "zustand";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/store";
import { useToasts } from "../../lib/toasts";

export interface Upload {
  key: string;
  name: string;
  dest: string;
  size: number;
  sent: number;
  state: "queued" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
  uploadId?: string;
}

interface UploadStore {
  items: Upload[];
  patch: (key: string, p: Partial<Upload>) => void;
  clearFinished: () => void;
}

export const useUploads = create<UploadStore>((set) => ({
  items: [],
  patch: (key, p) => set((s) => ({ items: s.items.map((u) => (u.key === key ? { ...u, ...p } : u)) })),
  clearFinished: () =>
    set((s) => ({ items: s.items.filter((u) => u.state === "queued" || u.state === "uploading") })),
}));

const cancelled = new Set<string>();

export function cancelUpload(key: string): void {
  cancelled.add(key);
  const u = useUploads.getState().items.find((x) => x.key === key);
  if (u?.uploadId) api(`/api/fs/upload/${u.uploadId}`, { method: "DELETE" }).catch(() => undefined);
  useUploads.getState().patch(key, { state: "cancelled" });
}

async function putChunk(id: string, offset: number, blob: Blob): Promise<number> {
  const csrf = useAuth.getState().csrf ?? "";
  const res = await fetch(`/api/fs/upload/${id}?offset=${offset}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrf, "content-type": "application/octet-stream" },
    body: blob,
  });
  const body = (await res.json().catch(() => ({}))) as {
    received?: number;
    detail?: { received?: number; message?: string };
  };
  if (res.status === 409 && typeof body.detail?.received === "number") return body.detail.received; // resync
  if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, body.detail?.message ?? "Upload failed");
  return body.received ?? offset + blob.size;
}

async function runOne(file: File, dest: string, key: string, onDone: () => void) {
  const { patch } = useUploads.getState();
  try {
    patch(key, { state: "uploading" });
    const init = await api<{ upload_id: string; chunk_size: number; received: number }>(
      "/api/fs/upload/init",
      {
        method: "POST",
        body: { dest_dir: dest, name: file.name, size: file.size },
      },
    );
    patch(key, { uploadId: init.upload_id });
    let offset = init.received;
    let retries = 0;
    while (offset < file.size) {
      if (cancelled.has(key)) return;
      try {
        offset = await putChunk(init.upload_id, offset, file.slice(offset, offset + init.chunk_size));
        retries = 0;
        patch(key, { sent: offset });
      } catch (err) {
        if (++retries > 5) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** retries));
        const st = await api<{ received: number }>(`/api/fs/upload/${init.upload_id}`).catch(() => ({
          received: offset,
        }));
        offset = st.received;
      }
    }
    await api(`/api/fs/upload/${init.upload_id}/complete`, { method: "POST", body: { conflict: "rename" } });
    patch(key, { state: "done", sent: file.size });
    onDone();
  } catch (err) {
    if (!cancelled.has(key))
      patch(key, { state: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** Upload files into `dest`, two at a time. */
export async function uploadFiles(files: File[], dest: string, onDone: () => void): Promise<void> {
  const jobs = files.map((f) => ({ f, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` }));
  useUploads.setState((s) => ({
    items: [
      ...s.items,
      ...jobs.map(({ f, key }) => ({
        key,
        name: f.name,
        dest,
        size: f.size,
        sent: 0,
        state: "queued" as const,
      })),
    ],
  }));
  const queue = [...jobs];
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) await runOne(j.f, dest, j.key, onDone);
  };
  await Promise.all([worker(), worker()]);
  window.setTimeout(() => {
    const items = useUploads.getState().items;
    const busy = items.some((u) => u.state === "queued" || u.state === "uploading" || u.state === "error");
    if (!busy) useUploads.getState().clearFinished();
  }, 5000);
  const failed = useUploads
    .getState()
    .items.filter((u) => jobs.some((j) => j.key === u.key) && u.state === "error");
  useToasts.getState().push(
    failed.length
      ? {
          tone: "error",
          title: `${failed.length} upload${failed.length > 1 ? "s" : ""} failed`,
          message: failed[0]?.error,
        }
      : {
          tone: "success",
          title: `Uploaded ${jobs.length} file${jobs.length > 1 ? "s" : ""}`,
          message: dest,
        },
  );
}
