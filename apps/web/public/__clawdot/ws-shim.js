/**
 * Clawdot preview WebSocket shim.
 *
 * Injected into preview documents by the service worker (preview-sw.js).
 * Service workers can intercept HTTP but not WebSockets, so this replaces
 * window.WebSocket with a stand-in that bridges each socket to the parent
 * app window via postMessage; the app forwards it through the daemon
 * connection as `preview.ws.*` and the daemon dials the real socket on
 * 127.0.0.1. Vite's HMR client is the main customer — it connects to
 * location.host, which is the app origin here, so without this shim hot
 * reload (and any other in-page WebSocket) would just fail. Sockets aimed
 * at loopback (an app talking to a second local port) tunnel to that port
 * on the daemon's machine — on the phone, localhost is nothing.
 *
 * Sockets to other origins are left to the native implementation.
 * Plain JS by design: served as-is from public/, no bundler involved.
 */
(() => {
  "use strict";
  if (window.__clawdotWsShim) return;
  // The previewed port: the service worker injects it as a global right
  // before this script (authoritative — on the fixed preview.<host> origin
  // nothing in the document's own URL carries it); URL parsing remains as
  // the fallback for the other shapes. In origin mode the parent app window
  // is the apex origin, so messages must target it explicitly.
  const pathMatch = location.pathname.match(/^\/preview\/(\d+)(\/|$)/);
  const hostMatch = location.hostname.match(/^p(\d{1,5})\./);
  const previewPort =
    typeof window.__clawdotPreviewPort === "number"
      ? window.__clawdotPreviewPort
      : pathMatch || hostMatch
        ? Number((pathMatch || hostMatch)[1])
        : null;
  // The app window holds the daemon connection: it's our parent in the
  // panel iframe, our opener in an "Open in new tab" preview.
  const bridge = window.parent !== window ? window.parent : window.opener;
  if (previewPort === null || !bridge) return;
  window.__clawdotWsShim = true;

  const bridgeOrigin = pathMatch
    ? location.origin
    : location.protocol + "//" + location.host.replace(/^(p\d+|preview)\./, "");
  const NativeWebSocket = window.WebSocket;
  const sockets = new Map();
  let nextId = 0;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toB64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fromB64(text) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** localhost in any spelling — see the same helper in preview-sw.js. */
  function isLoopbackHost(hostname) {
    const h = hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "[::1]" ||
      h === "0.0.0.0" ||
      h.endsWith(".localhost") ||
      h.startsWith("127.")
    );
  }

  window.addEventListener("message", (e) => {
    if (e.source !== bridge || e.origin !== bridgeOrigin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.socketId !== "string") return;
    const sock = sockets.get(d.socketId);
    if (!sock) return;
    if (d.type === "clawdot.ws.opened") sock._opened();
    else if (d.type === "clawdot.ws.message") sock._message(d.data, d.binary);
    else if (d.type === "clawdot.ws.closed") sock._closed(d.code);
  });

  class TunnelWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const u = new URL(url, location.href);
      // Sockets aimed at this page's own host belong to the previewed port;
      // loopback targets mean the daemon's machine (an app talking to a
      // second local port) and tunnel to that port. Everything else is the
      // native implementation's business.
      let port;
      let path;
      if (u.host === location.host) {
        port = previewPort;
        // The dev server must see the unprefixed path.
        const pm = u.pathname.match(/^\/preview\/\d+(\/.*)?$/);
        path = (pm ? pm[1] || "/" : u.pathname) + u.search;
      } else if (isLoopbackHost(u.hostname)) {
        port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
        path = u.pathname + u.search;
      } else {
        return new NativeWebSocket(url, protocols);
      }
      this.url = u.href;
      this.readyState = TunnelWebSocket.CONNECTING;
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.extensions = "";
      const list =
        typeof protocols === "string" ? [protocols] : protocols ? [...protocols] : [];
      this.protocol = list[0] || "";
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._id = "ws-" + nextId++ + "-" + Math.random().toString(36).slice(2);
      sockets.set(this._id, this);
      bridge.postMessage(
        {
          type: "clawdot.ws.open",
          socketId: this._id,
          port,
          path,
          protocols: list,
        },
        bridgeOrigin,
      );
    }

    _emit(event) {
      const handler = this["on" + event.type];
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }

    _opened() {
      if (this.readyState !== TunnelWebSocket.CONNECTING) return;
      this.readyState = TunnelWebSocket.OPEN;
      this._emit(new Event("open"));
    }

    _message(b64, binary) {
      if (this.readyState !== TunnelWebSocket.OPEN) return;
      const bytes = fromB64(b64);
      let data;
      if (!binary) data = decoder.decode(bytes);
      else if (this.binaryType === "blob") data = new Blob([bytes]);
      else data = bytes.buffer;
      this._emit(new MessageEvent("message", { data, origin: location.origin }));
    }

    _closed(code) {
      if (this.readyState === TunnelWebSocket.CLOSED) return;
      const failed = this.readyState === TunnelWebSocket.CONNECTING;
      this.readyState = TunnelWebSocket.CLOSED;
      sockets.delete(this._id);
      // Native sockets fire error before an unclean close; reconnect loops
      // (Vite's HMR client among them) listen for that pair.
      if (failed || code !== 1000) this._emit(new Event("error"));
      this._emit(
        new CloseEvent("close", {
          code: typeof code === "number" ? code : 1006,
          reason: "",
          wasClean: code === 1000,
        }),
      );
    }

    send(data) {
      if (this.readyState === TunnelWebSocket.CONNECTING) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          "InvalidStateError",
        );
      }
      if (this.readyState !== TunnelWebSocket.OPEN) return;
      if (typeof data === "string") {
        this._post(encoder.encode(data), false);
      } else if (data instanceof Blob) {
        // Async read; fine for the dev-tooling traffic this shim serves.
        data.arrayBuffer().then((buf) => {
          if (this.readyState === TunnelWebSocket.OPEN) {
            this._post(new Uint8Array(buf), true);
          }
        });
      } else if (data instanceof ArrayBuffer) {
        this._post(new Uint8Array(data), true);
      } else if (ArrayBuffer.isView(data)) {
        this._post(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), true);
      }
    }

    _post(bytes, binary) {
      bridge.postMessage(
        { type: "clawdot.ws.send", socketId: this._id, data: toB64(bytes), binary },
        bridgeOrigin,
      );
    }

    close(code) {
      if (
        this.readyState === TunnelWebSocket.CLOSING ||
        this.readyState === TunnelWebSocket.CLOSED
      ) {
        return;
      }
      this.readyState = TunnelWebSocket.CLOSING;
      bridge.postMessage(
        {
          type: "clawdot.ws.close",
          socketId: this._id,
          code: typeof code === "number" ? code : undefined,
        },
        bridgeOrigin,
      );
    }
  }

  TunnelWebSocket.CONNECTING = 0;
  TunnelWebSocket.OPEN = 1;
  TunnelWebSocket.CLOSING = 2;
  TunnelWebSocket.CLOSED = 3;
  Object.assign(TunnelWebSocket.prototype, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  });

  window.WebSocket = TunnelWebSocket;
})();
