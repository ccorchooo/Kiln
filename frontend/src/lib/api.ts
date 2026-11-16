import { useAuth } from "./store";

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number;
  body: unknown;

  constructor(status: number, code: string, message: string, retryAfter = 0, body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

interface Detail {
  code?: string;
  message?: string;
  retry_after?: number;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  const csrf = useAuth.getState().csrf;
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new ApiError(0, "network", "Can't reach Kiln. Check your Tailscale connection.", 0, String(err));
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const raw = (data as { detail?: Detail | string } | null)?.detail;
    const detail: Detail = typeof raw === "string" ? { message: raw } : (raw ?? {});
    const isAuthRoute = path.startsWith("/api/auth/");
    if (res.status === 423) useAuth.getState().setStatus("locked");
    if (res.status === 401 && !isAuthRoute) useAuth.getState().setStatus("signedOut");
    throw new ApiError(
      res.status,
      detail.code ?? `http_${res.status}`,
      detail.message ?? res.statusText ?? "Request failed",
      detail.retry_after ?? Number(res.headers.get("retry-after") ?? 0),
      data,
    );
  }
  return data as T;
}
