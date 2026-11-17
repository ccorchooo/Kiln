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
    /** Screenshot shown to a vision model (data URL). */
    screen?: string;
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
  screen?: string;
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

/**
 * One frame of what the user shares (this tab by default), as a JPEG data URL at most 1600 px
 * on the long side. The browser asks for permission each time; nothing keeps recording.
 */
export async function captureScreen(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Let the share prompt fade out of the captured tab before taking the frame.
    await new Promise((r) => setTimeout(r, 400));
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
