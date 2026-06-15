/**
 * Page-side half of the web preview. The service worker (preview-sw.js)
 * intercepts a preview iframe's HTTP and the injected shim
 * (__clawdot/ws-shim.js) captures its WebSockets, but neither holds the
 * daemon connection — its socket and crypto state live in this window. The
 * bridge is the relay between those two worlds and the `preview.*` protocol:
 *
 *   service worker ──MessageChannel──┐
 *                                    ├─ bridge ── post(preview.*) ── daemon
 *   iframe ws shim ──window.message──┘
 *
 * In origin mode (previews on p<port>.<host> subdomains) the SW lives on
 * another origin and can't message this window — the companion iframe
 * (__clawdot/preview-bridge.html) relays its messages over a MessagePort
 * the panel attaches via attachCompanion; ws-shim messages arrive as
 * regular cross-origin window messages from the preview origins.
 *
 * One bridge per app; it outlives reconnects (in-flight work is failed via
 * connectionLost so iframes see clean errors instead of hangs).
 */
import type { ClientMessage, ServerMessage } from "@clawdot/protocol";

/** Matches our preview subdomain origins: p<port>.<host> or preview.<host>. */
const PREVIEW_ORIGIN_RE = new RegExp(
  `^${location.protocol}//(p\\d{1,5}|preview)\\.${location.host.replace(/[.:[\]]/g, "\\$&")}$`,
);

function isPreviewSenderOrigin(origin: string): boolean {
  return origin === location.origin || PREVIEW_ORIGIN_RE.test(origin);
}

/** What the service worker posts for each intercepted request. */
interface SwFetchRequest {
  type: "clawdot.fetch";
  port: number;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  /** Absolute target URL for an allowlisted external fetch. */
  url?: string;
  /** The previewed page's own port (Origin/Referer rewriting daemon-side). */
  pagePort?: number;
  body?: string;
}

export interface PreviewBridge {
  /** Route a preview.* server message to its SW stream or iframe socket. */
  handleServerMessage(msg: ServerMessage): void;
  /**
   * The settings allowlist arrived/changed — cache it for the SW's queries
   * and push it so an already-running worker picks up the change.
   */
  setAllowedHosts(hosts: string[]): void;
  /**
   * Origin mode: take over a companion iframe's MessagePort (created by the
   * preview panel). Fetches/queries relayed from the preview origin's SW
   * arrive here; allowlist pushes flow back down. Returns a detach fn.
   */
  attachCompanion(port: MessagePort): () => void;
  /** Fail everything in flight — the daemon connection dropped. */
  connectionLost(): void;
  /** Unhook the window/service-worker listeners (StrictMode re-mounts). */
  dispose(): void;
}

export function createPreviewBridge(
  post: (msg: ClientMessage) => void,
): PreviewBridge {
  // In-flight preview.fetch requests → the MessagePort the SW is awaiting.
  const fetches = new Map<string, MessagePort>();
  // Open preview sockets → the iframe window that owns them, plus its
  // origin (origin mode iframes are cross-origin; replies must target it).
  const sockets = new Map<string, { win: Window; origin: string }>();
  // Companion channels of open origin-mode previews (allowlist push targets).
  const companions = new Set<MessagePort>();
  // Hosts the daemon may fetch beyond loopback (from settings); the SW asks
  // for these to decide tunnel-vs-direct for cross-origin preview requests.
  let allowedHosts: string[] = [];
  let nextId = 0;
  const newRequestId = () =>
    `r-${(nextId++).toString(36)}-${Math.random().toString(36).slice(2)}`;

  // One handler for both transports: the same-origin SW messages directly,
  // the origin-mode SWs message via their companion's MessagePort — the
  // payloads (and transferred reply ports) are identical.
  const handleBridgeMessage = (raw: unknown, ports: readonly MessagePort[]) => {
    const head = raw as { type?: unknown } | null;
    if (head?.type === "clawdot.allowlist.get") {
      ports[0]?.postMessage(allowedHosts);
      return;
    }
    if (head?.type !== "clawdot.fetch") return;
    const data = head as SwFetchRequest;
    const channel = ports[0];
    if (!channel) return;
    const requestId = newRequestId();
    fetches.set(requestId, channel);
    channel.onmessage = (ev: MessageEvent) => {
      // The SW cancels when the viewer navigates away mid-download.
      if ((ev.data as { type?: string } | null)?.type === "cancel") {
        fetches.delete(requestId);
        post({ type: "preview.abort", requestId });
      }
    };
    post({
      type: "preview.fetch",
      requestId,
      port: data.port,
      method: data.method,
      path: data.path,
      headers: data.headers,
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(typeof data.pagePort === "number" ? { pagePort: data.pagePort } : {}),
      ...(data.body !== undefined ? { body: data.body } : {}),
    });
  };

  const onSwMessage = (e: MessageEvent) => handleBridgeMessage(e.data, e.ports);

  const onWindowMessage = (e: MessageEvent) => {
    // Only preview iframes may drive sockets: same-origin (path mode) or
    // our own p<port>. subdomains (origin mode).
    if (!isPreviewSenderOrigin(e.origin) || !e.source) return;
    const d = e.data as {
      type?: unknown;
      socketId?: unknown;
      port?: unknown;
      path?: unknown;
      protocols?: unknown;
      data?: unknown;
      binary?: unknown;
      code?: unknown;
    } | null;
    if (!d || typeof d.type !== "string" || typeof d.socketId !== "string") return;
    switch (d.type) {
      case "clawdot.ws.open": {
        if (typeof d.port !== "number" || typeof d.path !== "string") return;
        const protocols = Array.isArray(d.protocols)
          ? d.protocols.filter((p): p is string => typeof p === "string")
          : [];
        sockets.set(d.socketId, { win: e.source as Window, origin: e.origin });
        post({
          type: "preview.ws.open",
          socketId: d.socketId,
          port: d.port,
          path: d.path,
          ...(protocols.length > 0 ? { protocols } : {}),
        });
        break;
      }
      case "clawdot.ws.send": {
        if (typeof d.data !== "string") return;
        post({
          type: "preview.ws.send",
          socketId: d.socketId,
          data: d.data,
          binary: d.binary === true,
        });
        break;
      }
      case "clawdot.ws.close": {
        post({
          type: "preview.ws.close",
          socketId: d.socketId,
          ...(typeof d.code === "number" ? { code: d.code } : {}),
        });
        break;
      }
    }
  };

  if ("serviceWorker" in navigator) {
    // Idempotent — same script URL and scope on every call.
    void navigator.serviceWorker.register("/preview-sw.js");
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    navigator.serviceWorker.startMessages();
  }
  window.addEventListener("message", onWindowMessage);

  const toSocket = (socketId: string, message: Record<string, unknown>) => {
    const sock = sockets.get(socketId);
    sock?.win.postMessage(message, sock.origin);
  };

  return {
    handleServerMessage(msg) {
      switch (msg.type) {
        case "preview.head":
          fetches.get(msg.requestId)?.postMessage({
            type: "head",
            status: msg.status,
            headers: msg.headers,
          });
          break;
        case "preview.body":
          fetches.get(msg.requestId)?.postMessage({ type: "chunk", data: msg.chunk });
          break;
        case "preview.end": {
          const port = fetches.get(msg.requestId);
          fetches.delete(msg.requestId);
          port?.postMessage({ type: "end" });
          break;
        }
        case "preview.error": {
          const port = fetches.get(msg.requestId);
          fetches.delete(msg.requestId);
          port?.postMessage({ type: "error", message: msg.message });
          break;
        }
        case "preview.ws.opened":
          toSocket(msg.socketId, { type: "clawdot.ws.opened", socketId: msg.socketId });
          break;
        case "preview.ws.message":
          toSocket(msg.socketId, {
            type: "clawdot.ws.message",
            socketId: msg.socketId,
            data: msg.data,
            binary: msg.binary,
          });
          break;
        case "preview.ws.closed":
          toSocket(msg.socketId, {
            type: "clawdot.ws.closed",
            socketId: msg.socketId,
            code: msg.code,
          });
          sockets.delete(msg.socketId);
          break;
      }
    },

    setAllowedHosts(hosts) {
      allowedHosts = hosts;
      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker.ready.then((reg) => {
          reg.active?.postMessage({ type: "clawdot.allowlist", hosts });
        });
      }
      for (const companion of companions) {
        companion.postMessage({ type: "clawdot.allowlist", hosts });
      }
    },

    attachCompanion(port) {
      companions.add(port);
      port.onmessage = (e: MessageEvent) => handleBridgeMessage(e.data, e.ports);
      port.start();
      // Seed the freshly registered SW with the current allowlist.
      port.postMessage({ type: "clawdot.allowlist", hosts: allowedHosts });
      return () => {
        companions.delete(port);
        port.close();
      };
    },

    connectionLost() {
      for (const port of fetches.values()) {
        port.postMessage({ type: "error", message: "connection to daemon lost" });
      }
      fetches.clear();
      for (const [socketId, sock] of sockets) {
        sock.win.postMessage(
          { type: "clawdot.ws.closed", socketId, code: 1006 },
          sock.origin,
        );
      }
      sockets.clear();
    },

    dispose() {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onSwMessage);
      }
      window.removeEventListener("message", onWindowMessage);
      for (const companion of companions) companion.close();
      companions.clear();
    },
  };
}
