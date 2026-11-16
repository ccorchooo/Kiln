/** One shared /ws/fs socket; folders are ref-counted across every open Files view. */
import type { QueryClient } from "@tanstack/react-query";

const counts = new Map<string, number>();
let ws: WebSocket | null = null;
let client: QueryClient | null = null;
let timer: number | null = null;
let attempt = 0;

function send() {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "watch", paths: [...counts.keys()].slice(0, 8) }));
}

function connect() {
  if (ws || counts.size === 0) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/ws/fs`);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    send();
  };
  sock.onmessage = (m) => {
    try {
      const msg = JSON.parse(String(m.data)) as { type: string; path?: string };
      if (msg.type === "changed" && msg.path) {
        void client?.invalidateQueries({ queryKey: ["fs", "list", msg.path] });
        void client?.invalidateQueries({ queryKey: ["fs", "trash"] });
      }
    } catch {
      /* ignore */
    }
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    if (counts.size === 0 || ev.code === 4401 || ev.code === 4423) return;
    timer = window.setTimeout(connect, Math.min(10000, 500 * 2 ** attempt++));
  };
}

export function watchDir(path: string, qc: QueryClient): () => void {
  client = qc;
  counts.set(path, (counts.get(path) ?? 0) + 1);
  if (ws) send();
  else connect();
  return () => {
    const n = (counts.get(path) ?? 1) - 1;
    if (n <= 0) counts.delete(path);
    else counts.set(path, n);
    if (counts.size === 0) {
      if (timer !== null) window.clearTimeout(timer);
      ws?.close(1000);
      ws = null;
    } else send();
  };
}
