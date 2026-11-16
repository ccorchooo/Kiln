# Phase 5 — Filesystem API contract

Shared by the backend (`backend/app/fs/`, `backend/app/routes_fs.py`) and the frontend
(`frontend/src/apps/files/`, `frontend/src/apps/editor/`, `frontend/src/previews/`).

## Conventions

- Every path in a request is a string: `~/a/b`, `a/b` (relative to home), or `/home/augus/a/b`.
  Every path goes through `app.fs.jail.Jail.resolve()` — no exceptions.
- Every path in a response is the display form `~/a/b` (`jail.relative()`), plus `name`.
- Errors: HTTP status + `{"detail": {"code", "message", ...}}`. Codes: `invalid_path` (400),
  `outside_jail` (403), `denied` (403, retry after re-auth), `not_found` (404), `exists` (409),
  `conflict` (409, editor mtime mismatch, includes `current_mtime_ns`), `too_large` (413),
  `binary` (415), `not_empty` (409), `unsupported` (400).
- Denylisted paths (`~/.ssh`, `**/.env`, …) appear in listings with `denied: true`, but reading
  their contents or listing inside them needs a recent re-auth (`RecentAuthDep` → allow_denied).
- Mutations need an unlocked session + CSRF (`SessionDep`). Permanent deletes and emptying the
  trash need `RecentAuthDep`. Everything that changes the disk is audited (`fs.*` events; paths,
  never contents).
- Symlinks are never followed for rename/move/trash/delete (they act on the link). Copy copies
  links as links. Listings report `type: "symlink"` + `target` (display form or null if outside).

## Entry shape

```json
{ "name": "notes.md", "path": "~/docs/notes.md", "type": "file|dir|symlink|other",
  "size": 1234, "mtime": 1731766000.12, "mode": "644", "owner": "augus", "group": "augus",
  "hidden": false, "mime": "text/markdown", "denied": false, "target": null,
  "link_type": "file|dir|null" }
```

`mime` comes from `mimetypes` + a few extras (`.md` text/markdown, `.glb` model/gltf-binary,
`.gltf` model/gltf+json, `.obj` model/obj, `.fbx` model/fbx, `.ts/.tsx` text/typescript, `.toml`,
`.yaml`, `.rs`, `.go`, `.sh`, `.fish`, `.zsh`, `.conf`, `.ini`, `.log` → text/*), and falls back to
sniffing the first 2 KB (NUL byte → application/octet-stream, else text/plain) for extensionless files.

## Endpoints

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/fs/list` | `path`, `hidden=0/1` | `{path, name, parent (display or null at ~), entries: [Entry]}` dirs first, then name (case-insensitive) |
| GET | `/api/fs/stat` | `path` | `Entry` + `{atime, ctime, items (dirs), real}` |
| GET | `/api/fs/raw` | `path`, `download=0/1` | the bytes, Range supported (206). Headers: `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. HTML/SVG/XML/JS are served as `text/plain` unless `download=1` (always `attachment` then). |
| GET | `/api/fs/text` | `path` | `{path, content, mtime_ns (string), size, encoding:"utf-8", eol:"lf|crlf"}`; 415 `binary` if not UTF-8 text; 413 over `files.max_read_bytes` |
| PUT | `/api/fs/text` | `{path, content, expected_mtime_ns: string|null}` | `{path, mtime_ns, size}`. `null` = create (409 `exists` if present). Mismatch → 409 `conflict` with `current_mtime_ns`. Atomic temp+rename, keeps mode, refuses to write through a symlink. |
| POST | `/api/fs/mkdir` | `{path}` | Entry |
| POST | `/api/fs/touch` | `{path}` | Entry (create empty file; 409 if exists) |
| POST | `/api/fs/rename` | `{path, new_name}` | Entry (`new_name` must be a single path component) |
| POST | `/api/fs/move` | `{sources: [], dest_dir, conflict: "rename|overwrite|error"}` | `{moved: [Entry]}` (default `rename` → `name (2).ext`) |
| POST | `/api/fs/copy` | same as move | `{copied: [Entry]}` (dirs recursively, in a thread) |
| POST | `/api/fs/chmod` | `{path, mode: "644"}` | Entry |
| GET | `/api/fs/checksum` | `path`, `algo=sha256|sha1|md5` | `{algo, hex}` |
| GET | `/api/fs/usage` | — | `{total, used, free, fs_type, mount}` for the filesystem holding home |
| GET/PUT | `/api/fs/bookmarks` | `{bookmarks: [{name, path}]}` (max 30) | same shape |
| POST | `/api/fs/trash` | `{paths: []}` | `{trashed: [{id, original_path}]}` — freedesktop Trash spec (`~/.local/share/Trash/files` + `info/<id>.trashinfo`, `Path=` URL-encoded absolute, `DeletionDate=YYYY-MM-DDThh:mm:ss`) |
| GET | `/api/fs/trash` | — | `{items: [{id, name, original_path, deleted_at, size, type}]}` newest first |
| POST | `/api/fs/trash/restore` | `{ids: []}` | `{restored: [Entry]}` (conflict → rename; missing parent dirs are recreated) |
| POST | `/api/fs/trash/delete` | `{ids: []}` | `{deleted: n}` — RecentAuth |
| POST | `/api/fs/trash/empty` | — | `{deleted: n}` — RecentAuth |
| POST | `/api/fs/delete` | `{paths: []}` | `{deleted: n}` permanent — RecentAuth |
| POST | `/api/fs/upload/init` | `{dest_dir, name, size}` | `{upload_id, chunk_size (4 MiB), received}` |
| GET | `/api/fs/upload/{id}` | — | `{received, size}` (resume) |
| PUT | `/api/fs/upload/{id}?offset=N` | raw bytes (≤ chunk_size) | `{received}`; offset must equal `received` else 409 `{received}` |
| POST | `/api/fs/upload/{id}/complete` | `{conflict: "rename|overwrite|error"}` | Entry. Partials live in `<data_dir>/uploads`, expire after 24 h. |
| DELETE | `/api/fs/upload/{id}` | — | `{ok}` |
| GET | `/api/fs/zip` | `paths` (repeatable) | streamed `application/zip` attachment (`<name>.zip` / `files.zip`), built on the fly; skips denied paths and symlinks pointing outside home |
| GET | `/api/fs/search` | `q`, `path`, `mode=name|content`, `hidden=0/1`, `glob?` | NDJSON stream. name: `{"type":"match", ...Entry}`; content: `{"type":"match", path, name, line, text, ranges:[[start,end]]}`; finally `{"type":"done", count, truncated}`. Uses `fd`/`rg --json` when present (os.walk/python fallback), max 500 matches, 20 s timeout, skips denied paths, kills the subprocess when the client disconnects. |
| GET | `/api/fs/archive` | `path` | `{format, entries: [{name, size, type, mtime}], truncated}` (zip, tar, tar.gz/bz2/xz/zst; max 5000 entries) |
| POST | `/api/fs/extract` | `{path, dest_dir?}` | Entry of the created folder (`<archive stem>/`, rename on conflict). Safe extraction only (tarfile `filter="data"`, zip member path checks). |
| POST | `/api/fs/compress` | `{paths: [], dest: "~/x.zip"}` | Entry (`.zip` or `.tar.gz`) |
| WS | `/ws/fs` | client → `{"type":"watch","paths":["~/docs"]}` (max 8 dirs, replaces the set) | server → `{"type":"changed","path":"~/docs"}` debounced 300 ms (non-recursive; watchfiles) |

## Deviations (as implemented)

- Name-search matches carry the entry's type as `kind` (the stream's `type` is `"match"`).
- Trash `deleted_at` is epoch seconds (float).
- Extra error codes: `offset_mismatch` (409, wrong upload offset, includes `received`), `incomplete`
  (409, completing an unfinished upload). Writing through a symlink is 400 `unsupported`.
- Symlinks to directories sort with directories.
