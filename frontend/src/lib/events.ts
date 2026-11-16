/** /ws/events client: reconnects with jittered exponential backoff. */

export interface KilnEvent {
  seq?: number;
  kind: string;
  data: Record<string, unknown>;
}

type Handler = (e: KilnEvent) => void;

export class EventSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private handler: Handler;
  private onAuthFailure: () => void;

  constructor(handler: Handler, onAuthFailure: () => void) {
    this.handler = handler;
    this.onAuthFailure = onAuthFailure;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/events`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (msg) => {
      try {
        this.handler(JSON.parse(String(msg.data)) as KilnEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (ev.code === 4401 || ev.code === 4403) {
        this.onAuthFailure();
        return;
      }
      const delay = Math.min(15000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }
}
