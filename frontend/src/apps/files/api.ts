/** Typed client for the Phase 5 filesystem API (see docs/phase5-fs-api.md). */
import { api } from "../../lib/api";

export type EntryType = "file" | "dir" | "symlink" | "other";

export interface Entry {
  name: string;
  path: string; // display form, "~/a/b"
  type: EntryType;
  size: number;
  mtime: number;
  mode: string;
  owner: string;
  group: string;
  hidden: boolean;
  mime: string | null;
  denied: boolean;
  target: string | null;
  link_type: "file" | "dir" | null;
}

export interface Listing {
  path: string;
  name: string;
  parent: string | null;
  entries: Entry[];
}

export interface TextFile {
  path: string;
  content: string;
  mtime_ns: string;
  size: number;
  encoding: string;
  eol: "lf" | "crlf";
}

export interface TrashItem {
  id: string;
  name: string;
  original_path: string;
  deleted_at: number; // epoch seconds
  size: number;
  type: EntryType;
}

const q = (params: Record<string, string | number | boolean | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v === true ? 1 : v === false ? 0 : v))}`)
    .join("&");

export const rawUrl = (path: string, download = false) => `/api/fs/raw?${q({ path, download })}`;
export const zipUrl = (paths: string[]) =>
  `/api/fs/zip?${paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&")}`;

export const fsApi = {
  list: (path: string, hidden: boolean) => api<Listing>(`/api/fs/list?${q({ path, hidden })}`),
  stat: (path: string) =>
    api<Entry & { atime: number; ctime: number; items?: number; real: string }>(
      `/api/fs/stat?${q({ path })}`,
    ),
  readText: (path: string) => api<TextFile>(`/api/fs/text?${q({ path })}`),
  writeText: (path: string, content: string, expected_mtime_ns: string | null) =>
    api<{ path: string; mtime_ns: string; size: number }>("/api/fs/text", {
      method: "PUT",
      body: { path, content, expected_mtime_ns },
    }),
  mkdir: (path: string) => api<Entry>("/api/fs/mkdir", { method: "POST", body: { path } }),
  touch: (path: string) => api<Entry>("/api/fs/touch", { method: "POST", body: { path } }),
  rename: (path: string, new_name: string) =>
    api<Entry>("/api/fs/rename", { method: "POST", body: { path, new_name } }),
  move: (sources: string[], dest_dir: string, conflict = "rename") =>
    api<{ moved: Entry[] }>("/api/fs/move", { method: "POST", body: { sources, dest_dir, conflict } }),
  copy: (sources: string[], dest_dir: string, conflict = "rename") =>
    api<{ copied: Entry[] }>("/api/fs/copy", { method: "POST", body: { sources, dest_dir, conflict } }),
  chmod: (path: string, mode: string) =>
    api<Entry>("/api/fs/chmod", { method: "POST", body: { path, mode } }),
  checksum: (path: string, algo = "sha256") =>
    api<{ algo: string; hex: string }>(`/api/fs/checksum?${q({ path, algo })}`),
  usage: () =>
    api<{ total: number; used: number; free: number; fs_type: string; mount: string }>("/api/fs/usage"),
  bookmarks: () => api<{ bookmarks: { name: string; path: string }[] }>("/api/fs/bookmarks"),
  setBookmarks: (bookmarks: { name: string; path: string }[]) =>
    api<{ bookmarks: { name: string; path: string }[] }>("/api/fs/bookmarks", {
      method: "PUT",
      body: { bookmarks },
    }),
  trash: (paths: string[]) =>
    api<{ trashed: { id: string; original_path: string }[] }>("/api/fs/trash", {
      method: "POST",
      body: { paths },
    }),
  trashList: () => api<{ items: TrashItem[] }>("/api/fs/trash"),
  restore: (ids: string[]) =>
    api<{ restored: Entry[] }>("/api/fs/trash/restore", { method: "POST", body: { ids } }),
  trashDelete: (ids: string[]) =>
    api<{ deleted: number }>("/api/fs/trash/delete", { method: "POST", body: { ids } }),
  emptyTrash: () => api<{ deleted: number }>("/api/fs/trash/empty", { method: "POST" }),
  remove: (paths: string[]) =>
    api<{ deleted: number }>("/api/fs/delete", { method: "POST", body: { paths } }),
  archive: (path: string) =>
    api<{
      format: string;
      entries: { name: string; size: number; type: string; mtime: number }[];
      truncated: boolean;
    }>(`/api/fs/archive?${q({ path })}`),
  extract: (path: string, dest_dir?: string) =>
    api<Entry>("/api/fs/extract", { method: "POST", body: { path, dest_dir } }),
  compress: (paths: string[], dest: string) =>
    api<Entry>("/api/fs/compress", { method: "POST", body: { paths, dest } }),
};

/** Coarse kind used to choose icons and previews. */
export type Kind =
  "dir" | "image" | "video" | "audio" | "pdf" | "markdown" | "code" | "text" | "model" | "archive" | "other";

const EXT_KIND: Record<string, Kind> = {
  md: "markdown",
  markdown: "markdown",
  pdf: "pdf",
  glb: "model",
  gltf: "model",
  obj: "model",
  fbx: "model",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  zst: "archive",
  "7z": "archive",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rs: "code",
  go: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  java: "code",
  kt: "code",
  rb: "code",
  php: "code",
  lua: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  fish: "code",
  json: "code",
  toml: "code",
  yaml: "code",
  yml: "code",
  xml: "code",
  html: "code",
  css: "code",
  scss: "code",
  sql: "code",
  vue: "code",
  svelte: "code",
  ini: "code",
  conf: "code",
  cfg: "code",
  nix: "code",
  dockerfile: "code",
  txt: "text",
  log: "text",
  csv: "text",
};

export function kindOf(e: Pick<Entry, "name" | "type" | "mime" | "link_type">): Kind {
  if (e.type === "dir" || e.link_type === "dir") return "dir";
  const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : e.name.toLowerCase();
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const m = e.mime ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/")) return "text";
  return "other";
}
