/** Ember API types and the NDJSON chat stream. */
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/store";

export type Risk = "safe" | "change" | "danger" | "root";
export type ImageSize = "square" | "landscape" | "portrait" | "wide" | "tall";

export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string;
}

export interface Msg {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: number;
  data: {
    kind?: "image" | "image_request";
    tool_calls?: ToolCallRef[];
    tool_call_id?: string;
    name?: string;
    status?: CallStatus;
    risk?: Risk;
    summary?: string;
    detail?: string;
    images?: string[];
    prompt?: string;
    size?: ImageSize;
    seed?: number;
    model?: string;
    reasoning?: string;
    tps?: number;
    error?: string;
    stopped?: boolean;
  };
}

export interface Approval {
  id: string;
  conversation_id: string;
  call_id: string;
  tool: string;
  risk: Risk;
  mode: "tap" | "typed";
  expect: string;
  summary: string;
  reason: string;
  detail: string;
  sudo: boolean;
  reauth: boolean;
}

export type CallStatus = "pending" | "awaiting" | "running" | "ok" | "error" | "denied";

export interface Call {
  id: string;
  name: string;
  risk: Risk;
  summary: string;
  detail: string;
  reason?: string;
  status: CallStatus;
  output: string;
  images: string[];
}

export interface ConvSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  running: boolean;
}

export interface Conversation extends ConvSummary {
  messages: Msg[];
  approvals: Approval[];
}

export interface Model {
  id: string;
  aliases: string[];
  status: string | null;
  vision: boolean;
  current: boolean;
}

export type StreamEvent =
  | { type: "start"; conversation: { id: string; title: string }; message: Msg }
  | { type: "turn"; model: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "message"; message: Msg }
  | {
      type: "tool_call";
      call: { id: string; name: string; risk: Risk; summary: string; detail: string; reason?: string };
    }
  | { type: "approval"; approval: Approval }
  | { type: "approval_resolved"; id: string }
  | { type: "tool_running"; call_id: string }
  | { type: "tool_output"; call_id: string; text: string; replace?: boolean }
  | {
      type: "tool_result";
      call_id: string;
      status: CallStatus;
      output: string;
      images: string[];
      message?: Msg;
    }
  | { type: "error"; message: string }
  | { type: "stopped" }
  | { type: "done" };

export interface ChatBody {
  text: string;
  conversation_id: string | null;
  image?: { size: ImageSize };
}

/** POST /api/ember/chat and call `onEvent` for each NDJSON line until the stream ends. */
export async function streamChat(body: ChatBody, onEvent: (e: StreamEvent) => void): Promise<void> {
  const csrf = useAuth.getState().csrf;
  let res: Response;
  try {
    res = await fetch("/api/ember/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, "network", "Can't reach Kiln. Check your Tailscale connection.", 0, String(err));
  }
  if (!res.ok || !res.body) {
    let detail: { code?: string; message?: string } = {};
    try {
      const raw = (await res.json()) as { detail?: typeof detail };
      detail = raw.detail ?? {};
    } catch {
      /* not JSON */
    }
    if (res.status === 423) useAuth.getState().setStatus("locked");
    if (res.status === 401) useAuth.getState().setStatus("signedOut");
    throw new ApiError(
      res.status,
      detail.code ?? `http_${res.status}`,
      detail.message ?? "Ember couldn't start",
    );
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        /* ignore malformed line */
      }
    }
  }
}

export const imageUrl = (path: string) => `/api/fs/raw?path=${encodeURIComponent(path)}`;
