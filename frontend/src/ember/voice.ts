/**
 * Ember's voice: the mic (MediaRecorder → server faster-whisper), spoken replies (AXION TTS,
 * played through Web Audio), the analyser that drives the orb, captions, and the orb's mood.
 */
import { create } from "zustand";
import { ApiError } from "../lib/api";
import { useAuth, useUI, type OrbMood } from "../lib/store";
import { toastError } from "../lib/toasts";
import { useEmber } from "./store";

export type VoicePhase = "idle" | "listening" | "transcribing" | "speaking";

interface VoiceState {
  phase: VoicePhase;
  caption: string;
  speakReplies: boolean;
}

const PREF = "kiln.ember.speak";
const readPref = () => {
  try {
    return localStorage.getItem(PREF) === "1";
  } catch {
    return false;
  }
};

export const useVoice = create<VoiceState>(() => ({ phase: "idle", caption: "", speakReplies: readPref() }));
const setV = (p: Partial<VoiceState>) => useVoice.setState(p);

export function setSpeakReplies(on: boolean) {
  setV({ speakReplies: on });
  try {
    localStorage.setItem(PREF, on ? "1" : "0");
  } catch {
    /* per-device convenience only */
  }
  if (!on) stopSpeaking();
}

async function post(path: string, body: BodyInit, type: string): Promise<Response> {
  const csrf = useAuth.getState().csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": type, ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body,
    });
  } catch (err) {
    throw new ApiError(0, "network", "Can't reach Kiln. Check your Tailscale connection.", 0, String(err));
  }
  if (!res.ok) {
    const detail = (
      (await res.json().catch(() => null)) as { detail?: { code?: string; message?: string } } | null
    )?.detail;
    if (res.status === 423) useAuth.getState().setStatus("locked");
    if (res.status === 401) useAuth.getState().setStatus("signedOut");
    throw new ApiError(
      res.status,
      detail?.code ?? `http_${res.status}`,
      detail?.message ?? "Voice request failed",
    );
  }
  return res;
}

// ---- Web Audio: one context, one analyser for whichever of mic / speech is live ----

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let raf = 0;

function audio(): { c: AudioContext; a: AnalyserNode } {
  if (!ctx || !analyser) {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
  }
  return { c: ctx, a: analyser };
}

/** Feed the orb level + 4 bands every frame; `onLevel` sees the level too. */
function meter(onLevel?: (level: number) => void) {
  cancelAnimationFrame(raf);
  const { a, c } = audio();
  const freq = new Uint8Array(a.frequencyBinCount);
  const time = new Uint8Array(a.fftSize);
  const hz = c.sampleRate / a.fftSize;
  // Speech-ish bands: <300 Hz, 300–1k, 1k–3k, 3k–8k.
  const edges = [80, 300, 1000, 3000, 8000].map((f) => Math.max(1, Math.round(f / hz)));
  const tick = () => {
    a.getByteFrequencyData(freq);
    a.getByteTimeDomainData(time);
    let sum = 0;
    for (const v of time) sum += ((v - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / time.length) * 4);
    const bands = [0, 1, 2, 3].map((i) => {
      let s = 0;
      for (let b = edges[i]!; b < edges[i + 1]!; b++) s += freq[b]!;
      return s / (edges[i + 1]! - edges[i]!) / 255;
    }) as [number, number, number, number];
    useUI.getState().set({ audio: { level, bands } });
    onLevel?.(level);
    raf = requestAnimationFrame(tick);
  };
  tick();
}

function meterOff() {
  cancelAnimationFrame(raf);
  useUI.getState().set({ audio: { level: 0, bands: [0, 0, 0, 0] } });
}

// ---- Listening ----

let rec: MediaRecorder | null = null;
let cancelRec: (() => void) | null = null; // stop without transcribing
let replyByVoice = false;

const SILENCE_MS = 1500; // stop this long after speech goes quiet
const NO_SPEECH_MS = 8000;
const MAX_MS = 60000;

export async function toggleListening() {
  if (rec) return stopListening();
  if (useVoice.getState().phase === "transcribing") return;
  stopSpeaking();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toastError(
      "Can't use the microphone",
      new Error("This browser can't record audio here (it needs HTTPS)."),
    );
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    toastError("Can't use the microphone", err);
    return;
  }
  const { c, a } = audio();
  await c.resume();
  const src = c.createMediaStreamSource(stream);
  src.connect(a); // analyser only: never to the speakers
  const chunks: Blob[] = [];
  const started = performance.now();
  let lastLoud = 0;
  let cancelled = false;
  const r = new MediaRecorder(stream);
  rec = r;
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = () => {
    rec = null;
    cancelRec = null;
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    meterOff();
    if (lastLoud && !cancelled) void transcribe(new Blob(chunks, { type: r.mimeType }));
    else setV({ phase: "idle", caption: "" });
  };
  cancelRec = () => {
    cancelled = true;
    if (r.state !== "inactive") r.stop();
  };
  r.start();
  setV({ phase: "listening", caption: "Listening…" });
  meter((level) => {
    const now = performance.now();
    if (level > 0.12) lastLoud = now;
    const quiet = lastLoud ? now - lastLoud > SILENCE_MS : now - started > NO_SPEECH_MS;
    if ((quiet || now - started > MAX_MS) && r.state === "recording") r.stop();
  });
}

export function stopListening() {
  if (rec && rec.state !== "inactive") rec.stop();
}

async function transcribe(blob: Blob) {
  setV({ phase: "transcribing", caption: "…" });
  try {
    const res = await post("/api/ember/voice/transcribe", blob, blob.type || "application/octet-stream");
    const { text } = (await res.json()) as { text: string };
    if (!text.trim()) {
      setV({ phase: "idle", caption: "" });
      return;
    }
    setV({ phase: "idle", caption: text });
    replyByVoice = true;
    useEmber.getState().ask(text);
  } catch (err) {
    setV({ phase: "idle", caption: "" });
    toastError("Couldn't hear that", err);
  }
}

// ---- Speaking ----

let playToken = 0;
let current: AudioBufferSourceNode | null = null;

/** Markdown → sentences worth saying aloud, grouped into short chunks (first one smallest, for latency). */
export function speechChunks(md: string): string[] {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_#>|~]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences =
    text
      .match(/[^.!?…]+[.!?…]*/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  const chunks: string[] = [];
  for (const s of sentences) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && chunks.length > 1 && last.length + s.length < 280)
      chunks[chunks.length - 1] = `${last} ${s}`;
    else chunks.push(s.slice(0, 4000));
  }
  return chunks;
}

function fetchSpeech(text: string): Promise<ArrayBuffer> {
  const p = post("/api/ember/voice/speak", JSON.stringify({ text }), "application/json").then((r) =>
    r.arrayBuffer(),
  );
  p.catch(() => {}); // a prefetch we abandon must not surface as unhandled
  return p;
}

export async function speak(markdown: string) {
  stopSpeaking();
  const token = playToken;
  const chunks = speechChunks(markdown);
  if (!chunks.length) return;
  const { c, a } = audio();
  await c.resume();
  let next = fetchSpeech(chunks[0]!);
  for (let i = 0; i < chunks.length; i++) {
    let buf: AudioBuffer;
    try {
      buf = await c.decodeAudioData(await next);
    } catch (err) {
      if (token === playToken) {
        stopSpeaking();
        toastError(`${useAuth.getState().assistantName} couldn't speak`, err);
      }
      return;
    }
    if (i + 1 < chunks.length) next = fetchSpeech(chunks[i + 1]!);
    if (token !== playToken) return;
    setV({ phase: "speaking", caption: chunks[i]! });
    if (i === 0) meter();
    await new Promise<void>((resolve) => {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.connect(a);
      src.onended = () => resolve();
      current = src;
      src.start();
    });
    if (token !== playToken) return;
  }
  stopSpeaking();
}

export function stopSpeaking() {
  playToken++;
  const src = current;
  current = null;
  src?.stop();
  if (useVoice.getState().phase === "speaking") {
    meterOff();
    setV({ phase: "idle", caption: "" });
  }
}

// Speak the reply when it was asked by voice, or when "read replies aloud" is on.
let runStart = 0;
useEmber.subscribe((s, prev) => {
  if (s.streaming && !prev.streaming) runStart = s.messages.length;
  if (!s.streaming && prev.streaming) {
    const want = replyByVoice || useVoice.getState().speakReplies;
    replyByVoice = false;
    const reply = s.messages
      .slice(runStart)
      .filter((m) => m.role === "assistant" && m.content.trim() && !m.data.error)
      .pop()?.content;
    if (want && reply) void speak(reply);
    else if (useVoice.getState().phase === "idle") setV({ caption: "" });
  }
});

// The mic and speech never outlive an unlocked session.
useAuth.subscribe((s) => {
  if (s.status !== "unlocked") {
    cancelRec?.();
    stopSpeaking();
  }
});

// ---- The orb reflects what Ember is doing ----

let errorTimer: number | null = null;

function syncMood() {
  const e = useEmber.getState();
  const { phase } = useVoice.getState();
  const mood: OrbMood =
    phase === "listening"
      ? "listening"
      : e.approvals.length
        ? "approval"
        : phase === "speaking"
          ? "speaking"
          : e.streaming || phase === "transcribing"
            ? "thinking"
            : e.error && errorTimer !== null
              ? "error"
              : "idle";
  if (useUI.getState().orbMood !== mood) useUI.getState().set({ orbMood: mood });
}

useEmber.subscribe((s, prev) => {
  if (s.error && s.error !== prev.error) {
    if (errorTimer !== null) window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => {
      errorTimer = null;
      syncMood();
    }, 4000);
  }
  syncMood();
});
useVoice.subscribe(syncMood);
