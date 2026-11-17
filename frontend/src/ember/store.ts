/**
 * Ember's client state: the sidebar, the open conversation, live tool calls and approvals,
 * the model list. Drives the orb's mood (thinking / awaiting approval / error).
 */
import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import { useUI } from "../lib/store";
import { toastError } from "../lib/toasts";
import {
  streamChat,
  type Approval,
  type Call,
  type Conversation,
  type ConvSummary,
  type ImageSize,
  type Model,
  type Msg,
  type StreamEvent,
} from "./api";

export type Mode = "chat" | "image";

interface EmberState {
  open: boolean;
  view: "chat" | "history";
  conversationId: string | null;
  title: string;
  messages: Msg[];
  calls: Record<string, Call>;
  /** Calls seen live that no stored message references yet (e.g. a direct image job). */
  liveCalls: string[];
  approvals: Approval[];
  streaming: boolean;
  draft: string;
  thinking: string;
  error: string | null;
  conversations: ConvSummary[];
  models: Model[];
  currentModel: string;
  reachable: boolean | null;
  mode: Mode;
  imageSize: ImageSize;
  /** Text queued for the composer (e.g. from a hand-off while a reply is streaming). */
  prefill: string | null;
}

interface EmberActions {
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setView: (view: EmberState["view"]) => void;
  setMode: (mode: Mode) => void;
  setImageSize: (size: ImageSize) => void;
  send: (text: string) => Promise<void>;
  ask: (text: string) => void;
  stop: () => Promise<void>;
  newChat: () => void;
  load: (id: string) => Promise<void>;
  loadHistory: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  loadModels: () => Promise<void>;
  setModel: (id: string) => Promise<void>;
  resolveApproval: (id: string) => void;
  takePrefill: () => string | null;
}

export type Ember = EmberState & EmberActions;

/** Rebuild call cards from stored messages (assistant tool_calls + tool results). */
function callsFrom(messages: Msg[]): Record<string, Call> {
  const calls: Record<string, Call> = {};
  for (const m of messages) {
    if (m.role === "assistant")
      for (const c of m.data.tool_calls ?? [])
        calls[c.id] ??= {
          id: c.id,
          name: c.name,
          risk: "safe",
          summary: c.name,
          detail: "",
          status: "pending",
          output: "",
          images: [],
        };
    if (m.role === "tool" && m.data.tool_call_id) {
      const id = m.data.tool_call_id;
      calls[id] = {
        ...(calls[id] ?? { id, name: m.data.name ?? "tool", images: [] }),
        id,
        name: m.data.name ?? calls[id]?.name ?? "tool",
        risk: m.data.risk ?? "safe",
        summary: m.data.summary ?? m.data.name ?? "tool",
        detail: m.data.detail ?? "",
        status: m.data.status ?? "ok",
        output: m.content,
        images: m.data.images ?? [],
      };
    }
  }
  return calls;
}

let errorTimer: number | null = null;

export const useEmber = create<Ember>()((set, get) => {
  const patchCall = (id: string, patch: Partial<Call>) =>
    set((s) => {
      const prev = s.calls[id];
      if (!prev) return {};
      return { calls: { ...s.calls, [id]: { ...prev, ...patch } } };
    });

  const onEvent = (e: StreamEvent) => {
    switch (e.type) {
      case "start":
        set((s) => ({
          conversationId: e.conversation.id,
          title: e.conversation.title,
          messages: [...s.messages.filter((m) => m.id !== -1), e.message],
        }));
        break;
      case "turn":
        set({ draft: "", thinking: "" });
        break;
      case "delta":
        set((s) => ({ draft: s.draft + e.text }));
        break;
      case "reasoning":
        set((s) => ({ thinking: s.thinking + e.text }));
        break;
      case "message":
        set((s) => {
          const calls = { ...s.calls };
          for (const c of e.message.data.tool_calls ?? [])
            calls[c.id] ??= {
              id: c.id,
              name: c.name,
              risk: "safe",
              summary: c.name,
              detail: "",
              status: "pending",
              output: "",
              images: [],
            };
          return { messages: [...s.messages, e.message], calls, draft: "", thinking: "" };
        });
        break;
      case "tool_call":
        set((s) => {
          const prev = s.calls[e.call.id];
          const call: Call = {
            output: "",
            images: [],
            ...prev,
            ...e.call,
            status: "pending",
          };
          const referenced = s.messages.some((m) => m.data.tool_calls?.some((c) => c.id === e.call.id));
          return {
            calls: { ...s.calls, [call.id]: call },
            liveCalls: referenced ? s.liveCalls : [...s.liveCalls, call.id],
          };
        });
        break;
      case "approval":
        set((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== e.approval.id), e.approval] }));
        patchCall(e.approval.call_id, { status: "awaiting" });
        break;
      case "approval_resolved":
        get().resolveApproval(e.id);
        break;
      case "tool_running":
        patchCall(e.call_id, { status: "running" });
        break;
      case "tool_output":
        set((s) => {
          const prev = s.calls[e.call_id];
          if (!prev) return {};
          const output = e.replace ? e.text : (prev.output + e.text).slice(-60000);
          return { calls: { ...s.calls, [e.call_id]: { ...prev, output, status: "running" } } };
        });
        break;
      case "tool_result":
        patchCall(e.call_id, { status: e.status, output: e.output, images: e.images });
        if (e.message) set((s) => ({ messages: [...s.messages, e.message!] }));
        break;
      case "error":
        set({ error: e.message });
        break;
      case "stopped":
      case "done":
        break;
    }
  };

  return {
    open: false,
    view: "chat",
    conversationId: null,
    title: "",
    messages: [],
    calls: {},
    liveCalls: [],
    approvals: [],
    streaming: false,
    draft: "",
    thinking: "",
    error: null,
    conversations: [],
    models: [],
    currentModel: "",
    reachable: null,
    mode: "chat",
    imageSize: "square",
    prefill: null,

    setOpen: (open) => {
      set({ open });
      if (open && get().reachable === null) void get().loadModels();
    },
    toggle: () => get().setOpen(!get().open),
    setView: (view) => {
      set({ view });
      if (view === "history") void get().loadHistory();
    },
    setMode: (mode) => set({ mode }),
    setImageSize: (imageSize) => set({ imageSize }),

    send: async (raw) => {
      const text = raw.trim();
      if (!text || get().streaming) return;
      const { mode, imageSize, conversationId } = get();
      const optimistic: Msg = {
        id: -1,
        role: "user",
        content: text,
        created_at: Date.now() / 1000,
        data: mode === "image" ? { kind: "image_request", size: imageSize } : {},
      };
      set((s) => ({
        streaming: true,
        error: null,
        draft: "",
        thinking: "",
        view: "chat",
        messages: [...s.messages, optimistic],
      }));
      try {
        await streamChat(
          {
            text,
            conversation_id: conversationId,
            ...(mode === "image" ? { image: { size: imageSize } } : {}),
          },
          onEvent,
        );
      } catch (err) {
        set((s) => ({
          error: err instanceof ApiError ? err.message : "Ember couldn't answer",
          messages: s.messages.filter((m) => m.id !== -1),
        }));
      } finally {
        set({ streaming: false, approvals: [], draft: "", thinking: "" });
        const id = get().conversationId;
        if (id) {
          // Re-sync with what the server stored (the source of truth).
          try {
            const conv = await api<Conversation>(`/api/ember/conversations/${id}`);
            if (get().conversationId === id && !get().streaming)
              set({
                messages: conv.messages,
                calls: callsFrom(conv.messages),
                liveCalls: [],
                title: conv.title,
              });
          } catch {
            /* keep the live view */
          }
        }
      }
    },

    ask: (text) => {
      get().setOpen(true);
      if (get().streaming) {
        set({ prefill: text });
        return;
      }
      set({ mode: "chat" });
      void get().send(text);
    },

    stop: async () => {
      const id = get().conversationId;
      if (!id) return;
      try {
        await api(`/api/ember/conversations/${id}/stop`, { method: "POST" });
      } catch (err) {
        toastError("Couldn't stop Ember", err);
      }
    },

    newChat: () => {
      if (get().streaming) return;
      set({
        conversationId: null,
        title: "",
        messages: [],
        calls: {},
        liveCalls: [],
        approvals: [],
        error: null,
        view: "chat",
      });
    },

    load: async (id) => {
      if (get().streaming) return;
      try {
        const conv = await api<Conversation>(`/api/ember/conversations/${id}`);
        set({
          conversationId: conv.id,
          title: conv.title,
          messages: conv.messages,
          calls: callsFrom(conv.messages),
          liveCalls: [],
          approvals: [],
          error: null,
          view: "chat",
        });
      } catch (err) {
        toastError("Couldn't open that chat", err);
      }
    },

    loadHistory: async () => {
      try {
        const r = await api<{ conversations: ConvSummary[] }>("/api/ember/conversations");
        set({ conversations: r.conversations });
      } catch (err) {
        toastError("Couldn't load chats", err);
      }
    },

    remove: async (id) => {
      try {
        await api(`/api/ember/conversations/${id}`, { method: "DELETE" });
        set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }));
        if (get().conversationId === id) get().newChat();
      } catch (err) {
        toastError("Couldn't delete that chat", err);
      }
    },

    loadModels: async () => {
      try {
        const r = await api<{ models: Model[]; current: string; reachable: boolean }>("/api/ember/models");
        set({ models: r.models, currentModel: r.current, reachable: r.reachable });
      } catch {
        set({ reachable: false });
      }
    },

    setModel: async (id) => {
      const prev = get().currentModel;
      set({ currentModel: id });
      try {
        const r = await api<{ current: string }>("/api/ember/model", { method: "PUT", body: { model: id } });
        set((s) => ({
          currentModel: r.current,
          models: s.models.map((m) => ({ ...m, current: m.id === r.current })),
        }));
      } catch (err) {
        set({ currentModel: prev });
        toastError("Couldn't switch model", err);
      }
    },

    resolveApproval: (id) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })),

    takePrefill: () => {
      const p = get().prefill;
      if (p !== null) set({ prefill: null });
      return p;
    },
  };
});

// The orb reflects what Ember is doing.
useEmber.subscribe((s, prev) => {
  if (s.error && s.error !== prev.error) {
    if (errorTimer !== null) window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => {
      errorTimer = null;
      const ui = useUI.getState();
      if (ui.orbMood === "error") ui.set({ orbMood: "idle" });
    }, 4000);
  }
  const mood = s.approvals.length
    ? "approval"
    : s.streaming
      ? "thinking"
      : s.error && errorTimer !== null
        ? "error"
        : "idle";
  if (useUI.getState().orbMood !== mood) useUI.getState().set({ orbMood: mood });
});
