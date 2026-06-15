/**
 * Preview proxy — serves `preview.*` messages by forwarding HTTP requests and
 * WebSockets to servers on THIS machine (loopback; the daemon is a port
 * forwarder for the user's own dev servers, never a general proxy). The one
 * deliberate exception: `preview.fetch` with an absolute `url` is served for
 * hostnames the user explicitly allowlisted in settings, so previewed apps
 * can call APIs the phone's browser can't reach (CORS allowlists pinned to
 * localhost, hosts on the user's private network). The allowlist is the
 * boundary that keeps this from becoming an open proxy a malicious previewed
 * page could abuse — never serve a URL fetch without consulting it.
 *
 * One instance per connection: everything in flight is owned by the client
 * that asked for it, so a vanished phone aborts its requests and closes its
 * sockets — the same no-orphans rule ephemeral terminals follow.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "@clawdot/protocol";
import type { CookieJar } from "./cookies.js";

/**
 * Loopback addresses to try, in order. Both stacks matter: dev servers
 * bound to `localhost` often listen on ONLY one of them (Vite on macOS ends
 * up ::1-only), so a refused IPv4 connect falls through to IPv6.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]"];

/** Walk err.cause/AggregateError for a "nothing listens there" errno. */
function connectionRefused(err: unknown): boolean {
  const queue = [err];
  while (queue.length > 0) {
    const e = queue.pop();
    if (!(e instanceof Error)) continue;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENETUNREACH" || code === "EHOSTUNREACH") {
      return true;
    }
    if (e instanceof AggregateError) queue.push(...e.errors);
    if (e.cause) queue.push(e.cause);
  }
  return false;
}

/**
 * Request headers the daemon must not forward: hop-by-hop/transport headers
 * (undici manages those), `host` (derived from the target URL so vhost checks
 * like Vite's allowedHosts pass), and browser context headers (`origin`,
 * `referer` carry the app's origin, which would trip CSRF/origin checks on
 * dev servers). When the client supplies `pagePort`, origin/referer are
 * re-synthesized as `http://localhost:<pagePort>` after stripping — the
 * request then looks exactly like local browsing, which is what
 * origin-checking backends (Better Auth & co.) expect.
 */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "accept-encoding",
  "origin",
  "referer",
  "cookie",
]);

/**
 * Response headers stripped before forwarding: framing headers that no longer
 * match the re-streamed body (fetch already decompressed it), headers that
 * would block rendering inside the app's iframe (CSP, x-frame-options), and
 * cookies (a service-worker-constructed Response can't set them anyway —
 * forwarding them would only leak dev-server cookies into protocol traffic).
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "trailer",
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
]);

/** Body chunks are re-sliced so one giant read never makes a giant message. */
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_INFLIGHT_REQUESTS = 128;
const MAX_SOCKETS = 64;

export class PreviewProxy {
  private readonly requests = new Map<string, AbortController>();
  private readonly sockets = new Map<string, WebSocket>();
  private disposed = false;

  constructor(
    private readonly send: (msg: ServerMessage) => void,
    /** Live view of the settings allowlist for absolute-URL fetches. */
    private readonly allowedHosts: () => string[] = () => [],
    /**
     * Daemon-wide cookie jar: holds the sessions of previewed apps, since
     * the browser can't (see cookies.ts). Optional only for tests.
     */
    private readonly jar?: CookieJar,
  ) {}

  fetch(msg: {
    requestId: string;
    port: number;
    method: string;
    path: string;
    headers: Array<[string, string]>;
    url?: string;
    pagePort?: number;
    body?: string;
  }): void {
    if (this.disposed || this.requests.has(msg.requestId)) return;
    if (this.requests.size >= MAX_INFLIGHT_REQUESTS) {
      this.send({
        type: "preview.error",
        requestId: msg.requestId,
        message: "too many requests in flight",
      });
      return;
    }
    const ctrl = new AbortController();
    this.requests.set(msg.requestId, ctrl);
    void this.run(msg, ctrl).finally(() => this.requests.delete(msg.requestId));
  }

  /**
   * Resolve the URL(s) a preview.fetch may hit, in fallback order. The port
   * form gets both loopback stacks; the absolute-url form gets exactly the
   * requested URL, and only when its hostname is on the user's allowlist.
   * Throws (→ preview.error) for anything else — this check is the whole
   * security boundary, see the class comment.
   */
  private targets(msg: { port: number; path: string; url?: string }): string[] {
    if (msg.url === undefined) {
      return LOOPBACK_HOSTS.map((host) => `http://${host}:${msg.port}${msg.path}`);
    }
    const url = new URL(msg.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${url.protocol}`);
    }
    if (!this.allowedHosts().includes(url.hostname.toLowerCase())) {
      throw new Error(
        `host not allowed: ${url.hostname} — add it to the preview host allowlist in settings`,
      );
    }
    return [url.href];
  }

  private async run(
    msg: {
      requestId: string;
      port: number;
      method: string;
      path: string;
      headers: Array<[string, string]>;
      url?: string;
      pagePort?: number;
      body?: string;
    },
    ctrl: AbortController,
  ): Promise<void> {
    const { requestId } = msg;
    try {
      const targets = this.targets(msg);
      const headers = new Headers();
      for (const [name, value] of msg.headers) {
        if (!STRIP_REQUEST_HEADERS.has(name.toLowerCase())) {
          headers.append(name, value);
        }
      }
      const method = msg.method.toUpperCase();
      const bodyAllowed = method !== "GET" && method !== "HEAD";
      // Synthesize the browser-context headers as the localhost equivalents
      // a local browser would have sent. They can NOT be carried over from
      // the real request: service workers never see Origin/Referer — the
      // browser attaches them below the worker, so the daemon must emulate
      // its rules instead (Origin on non-GET/HEAD; Referer on everything).
      if (msg.pagePort !== undefined) {
        if (bodyAllowed) {
          headers.set("origin", `http://localhost:${msg.pagePort}`);
        }
        headers.set("referer", `http://localhost:${msg.pagePort}/`);
      }
      let res: Response | undefined;
      let servedBy: URL | undefined;
      for (let i = 0; i < targets.length; i++) {
        const target = new URL(targets[i]!);
        // The previewed app's session lives daemon-side (the browser can't
        // hold it through the tunnel) — replay it; the browser's own cookie
        // header was stripped, it belongs to the IDE origin.
        const cookie = this.jar?.cookieHeader(target);
        if (cookie) headers.set("cookie", cookie);
        else headers.delete("cookie");
        try {
          res = await fetch(target, {
            method,
            headers,
            body:
              bodyAllowed && msg.body !== undefined
                ? Buffer.from(msg.body, "base64")
                : undefined,
            // Redirects go back to the browser — following them here would
            // hide the location change from the iframe and break relative
            // URLs. Set-Cookie on each hop is captured below as the browser
            // re-enters per hop.
            redirect: "manual",
            signal: ctrl.signal,
          });
          servedBy = target;
          break;
        } catch (err) {
          const lastTarget = i === targets.length - 1;
          if (lastTarget || ctrl.signal.aborted || !connectionRefused(err)) throw err;
        }
      }
      if (!res || !servedBy) throw new Error("unreachable: no fetch attempt ran");
      this.jar?.store(servedBy, res.headers.getSetCookie());

      const outHeaders: Array<[string, string]> = [];
      res.headers.forEach((value, name) => {
        if (!STRIP_RESPONSE_HEADERS.has(name)) outHeaders.push([name, value]);
      });
      this.send({
        type: "preview.head",
        requestId,
        status: res.status,
        headers: outHeaders,
      });

      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          for (let i = 0; i < chunk.length; i += MAX_CHUNK_BYTES) {
            if (this.disposed || ctrl.signal.aborted) return;
            this.send({
              type: "preview.body",
              requestId,
              chunk: Buffer.from(
                chunk.subarray(i, i + MAX_CHUNK_BYTES),
              ).toString("base64"),
            });
          }
        }
      }
      if (!this.disposed) this.send({ type: "preview.end", requestId });
    } catch (err) {
      // An abort means the client cancelled or vanished — nobody to tell.
      if (this.disposed || ctrl.signal.aborted) return;
      // fetch wraps the useful part ("connection refused") in err.cause.
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      this.send({
        type: "preview.error",
        requestId,
        message: (err instanceof Error ? err.message : String(err)) + cause,
      });
    }
  }

  abort(requestId: string): void {
    this.requests.get(requestId)?.abort();
    this.requests.delete(requestId);
  }

  wsOpen(msg: {
    socketId: string;
    port: number;
    path: string;
    protocols?: string[];
  }): void {
    if (this.disposed || this.sockets.has(msg.socketId)) return;
    const { socketId } = msg;
    if (this.sockets.size >= MAX_SOCKETS) {
      this.send({ type: "preview.ws.closed", socketId, code: 1013 });
      return;
    }
    const tryHost = (hostIndex: number) => {
      const target = `ws://${LOOPBACK_HOSTS[hostIndex]}:${msg.port}${msg.path}`;
      // Socket handshakes carry the previewed app's session too (Socket.IO
      // and friends auth via cookie).
      const cookie = this.jar?.cookieHeader(new URL(target));
      const ws = new WebSocket(target, msg.protocols ?? [], {
        ...(cookie ? { headers: { cookie } } : {}),
      });
      this.sockets.set(socketId, ws);
      let opened = false;
      // A failed connect emits error then close; kept for the fallback test.
      let connectError: unknown;
      ws.on("error", (err) => {
        connectError = err;
      });
      ws.on("open", () => {
        opened = true;
        if (!this.disposed) this.send({ type: "preview.ws.opened", socketId });
      });
      ws.on("message", (data, isBinary) => {
        if (this.disposed) return;
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        this.send({
          type: "preview.ws.message",
          socketId,
          data: buf.toString("base64"),
          binary: isBinary,
        });
      });
      ws.on("close", (code) => {
        const nextHost = hostIndex + 1;
        if (
          !opened &&
          !this.disposed &&
          nextHost < LOOPBACK_HOSTS.length &&
          connectionRefused(connectError)
        ) {
          tryHost(nextHost); // replaces this socket in the map
          return;
        }
        if (this.sockets.delete(socketId) && !this.disposed) {
          this.send({ type: "preview.ws.closed", socketId, code });
        }
      });
    };
    tryHost(0);
  }

  wsSend(socketId: string, data: string, binary: boolean): void {
    const ws = this.sockets.get(socketId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data, "base64"), { binary });
    }
  }

  wsClose(socketId: string, code?: number): void {
    const ws = this.sockets.get(socketId);
    if (!ws) return;
    try {
      // ws rejects reserved close codes (1001-2999 except a few) with a throw.
      if (code === 1000 || (code !== undefined && code >= 3000)) ws.close(code);
      else ws.close();
    } catch {
      ws.close();
    }
  }

  /** Abort everything — the owning connection is gone. */
  dispose(): void {
    this.disposed = true;
    for (const ctrl of this.requests.values()) ctrl.abort();
    this.requests.clear();
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
  }
}
