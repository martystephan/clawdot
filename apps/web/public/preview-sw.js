/**
 * Clawdot preview service worker.
 *
 * Makes a preview origin (or iframe path) behave like a window onto
 * `http://127.0.0.1:<port>` on the daemon's machine: every request from a
 * preview document is intercepted here, handed to the app window over a
 * MessageChannel, sent through the (E2E-encrypted) daemon connection as a
 * `preview.fetch`, and the streamed response is reassembled into a Response.
 * The app page is the bridge because the daemon socket and its crypto state
 * live there — this worker holds no keys and talks to no network itself
 * (except to pass through the app's own requests untouched).
 *
 * TWO MODES, decided by this worker's own hostname:
 *
 * Origin mode — registered on a preview subdomain (the relay serves the
 * same static bundle for any Host). The previewed page's URL path is the
 * real path (`/dashboard`, not `/preview/5173/dashboard`), so client
 * routers, pushState, SSR hydration and absolute URLs all work. EVERY
 * same-origin path proxies to the previewed port — except `/__clawdot/*`,
 * where the companion page lives: the app embeds
 * `/__clawdot/preview-bridge.html` as a hidden iframe, and since the app
 * window (which holds the daemon socket) is a different origin that this
 * worker cannot message, the companion is the relay between them. Two
 * subdomain shapes:
 *   - `preview.<app-host>` — the recommended setup: ONE ordinary DNS
 *     record and an ordinary certificate (Let's Encrypt HTTP validation
 *     works; wildcards would need DNS-API challenges). The hostname can't
 *     carry the port, so the companion supplies it (?port=… in its URL):
 *     pushed after registration, queried back after a worker restart.
 *   - `p<port>.<app-host>` — wildcard DNS, one origin per port; the port
 *     rides the hostname and previews get per-port storage isolation.
 *
 * Path mode — registered on the app origin itself; previews live under
 * `/preview/<port>/`. Kept as the fallback for the Tauri shell (its origin
 * is the app bundle — no subdomains) and for self-hosts without a preview
 * subdomain. Known limit: pages can read location.pathname and see the
 * prefix, which breaks client-side routers.
 *
 * Path-mode routing, in order:
 *   1. /__clawdot/*           → network (the ws shim file, never proxied)
 *   2. /preview/<port>/<path> → proxy <path> to <port>
 *   3. requester (referrer/client) lives under /preview/<port>/
 *                             → proxy the raw path to that port; this is what
 *                               catches absolute-path subresources like
 *                               /assets/app.js that escape the URL prefix
 *   4. cross-origin request FROM a preview page:
 *      - to localhost/127.0.0.1/[::1]  → proxy to that port on the daemon's
 *        machine (a frontend calling its API on another local port would
 *        otherwise hit the phone's own localhost and die)
 *      - to a host on the user's settings allowlist → proxy the full URL
 *        through the daemon; the response is synthesized here, so the
 *        browser never runs a CORS check against it
 *      - anything else → network, exactly as if we weren't here
 *   5. anything else          → network (the app's own traffic)
 *
 * Plain JS by design: served as-is from public/, no bundler involved.
 */

/* eslint-env serviceworker */

const PREVIEW_RE = /^\/preview\/(\d+)(\/.*)?$/;
/** How long the bridge may take to produce response headers. */
const HEAD_TIMEOUT_MS = 30000;
const SHIM_TAG = '<script src="/__clawdot/ws-shim.js"></script>';

/** Origin mode, p<port> shape: the previewed port rides the hostname. */
const HOST_PORT = (() => {
  const m = self.location.hostname.match(/^p(\d{1,5})\./);
  return m ? Number(m[1]) : null;
})();
/** Origin mode, fixed shape: one preview.<host> origin for whatever port. */
const FIXED_ORIGIN = /^preview\./.test(self.location.hostname);
const ORIGIN_MODE = HOST_PORT !== null || FIXED_ORIGIN;
/**
 * The fixed origin's current port — pushed by the companion when a preview
 * opens, re-queried from it when this worker restarts with empty state.
 */
let fixedPort = null;

/** The previewed port in origin mode (null outside it / nothing open). */
async function originPort() {
  if (HOST_PORT !== null) return HOST_PORT;
  if (!FIXED_ORIGIN) return null;
  if (fixedPort !== null) return fixedPort;
  const bridge = await findBridge();
  if (!bridge) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (typeof e.data === "number") fixedPort = e.data;
      resolve(fixedPort);
    };
    bridge.postMessage({ type: "clawdot.port.get" }, [channel.port2]);
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/**
 * Hostnames the daemon may fetch beyond loopback, pushed by the bridge and
 * pulled on demand (a service worker restarts with empty state). null until
 * a bridge has answered once.
 */
let allowedHosts = null;

self.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.type === "clawdot.allowlist" && Array.isArray(d.hosts)) {
    allowedHosts = d.hosts.map((h) => String(h).toLowerCase());
  } else if (d && d.type === "clawdot.port" && typeof d.port === "number") {
    fixedPort = d.port;
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // A bug in here must never take the app itself down — fall back to the
  // network rather than failing the request.
  if (url.origin === self.location.origin) {
    const handler = ORIGIN_MODE ? handleOriginMode : handle;
    event.respondWith(handler(event, url).catch(() => fetch(event.request)));
    return;
  }
  // Cross-origin http(s) may still belong to a preview (an app calling its
  // API on another local port, or an allowlisted external host) — decided
  // async in handleCrossOrigin; everything else passes through untouched.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  event.respondWith(handleCrossOrigin(event, url).catch(() => fetch(event.request)));
});

/**
 * Origin mode: the whole origin IS the preview — every path proxies to the
 * hostname's port. Only the clawdot plumbing (the companion page, the ws
 * shim, this worker's own script) stays on the network, served by the
 * relay's host-agnostic static hosting. None of path mode's heuristics
 * (referrer fallback, navigation bouncing) exist here: the page's URL is
 * already the real one.
 */
async function handleOriginMode(event, url) {
  if (url.pathname.startsWith("/__clawdot/") || url.pathname === "/preview-sw.js") {
    return fetch(event.request);
  }
  const port = await originPort();
  if (port === null) {
    return new Response(
      "clawdot preview: no preview is open for this origin — open one from the app",
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }
  return forward(event, port, url.pathname + url.search);
}

async function handle(event, url) {
  if (url.pathname.startsWith("/__clawdot/")) return fetch(event.request);

  const direct = url.pathname.match(PREVIEW_RE);
  if (direct) {
    return forward(event, Number(direct[1]), (direct[2] || "/") + url.search);
  }

  const port = await contextPort(event);
  if (port === null) return fetch(event.request);

  if (event.request.mode === "navigate") {
    // An absolute-path navigation inside a preview (redirect to /login, a
    // plain <a href="/docs">) escaped the prefix. Bounce it back under
    // /preview/<port>/ so the new document's URL keeps carrying its port.
    return Response.redirect(`/preview/${port}${url.pathname}${url.search}`, 302);
  }
  return forward(event, port, url.pathname + url.search);
}

/** localhost in any spelling — meaningful on the daemon's machine, not here. */
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

/**
 * A cross-origin request made by a preview page. Loopback targets always
 * tunnel — they mean the daemon's machine, and on the phone they'd hit
 * nothing. Allowlisted hosts tunnel by full URL (the daemon re-checks the
 * allowlist; this copy only decides tunnel-vs-direct). Everything else goes
 * to the network as if we weren't here, CORS and all.
 */
async function handleCrossOrigin(event, url) {
  const port = await contextPort(event);
  if (port === null) return fetch(event.request);
  if (isLoopbackHost(url.hostname)) {
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return forward(event, targetPort, url.pathname + url.search, undefined, port);
  }
  const hosts = await getAllowedHosts();
  if (hosts.includes(url.hostname.toLowerCase())) {
    return forward(event, port, url.pathname + url.search, url.href);
  }
  return fetch(event.request);
}

/** The allowlist, asked of the bridge once and then kept fresh by pushes. */
async function getAllowedHosts() {
  if (allowedHosts) return allowedHosts;
  const bridge = await findBridge();
  if (!bridge) return [];
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    // On timeout, fail open to "not allowlisted" but don't cache — the next
    // request asks again.
    const timer = setTimeout(() => resolve([]), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (Array.isArray(e.data)) {
        allowedHosts = e.data.map((h) => String(h).toLowerCase());
      }
      resolve(allowedHosts || []);
    };
    bridge.postMessage({ type: "clawdot.allowlist.get" }, [channel.port2]);
  });
}

/**
 * Which preview (port) does this request belong to? The referrer is checked
 * first because it is known synchronously and covers the common case (a
 * document under /preview/<port>/ loading absolute-path subresources); the
 * requesting client's URL covers the rest (e.g. url() loads from a stylesheet
 * that itself lives at an unprefixed path — its referrer is the stylesheet,
 * but its client is still the prefixed document).
 */
async function contextPort(event) {
  // Origin mode: every page on this origin is the preview of its port.
  if (ORIGIN_MODE) return originPort();
  const sources = [];
  if (event.request.referrer) sources.push(event.request.referrer);
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) sources.push(client.url);
  }
  for (const source of sources) {
    try {
      const u = new URL(source);
      if (u.origin !== self.location.origin) continue;
      const m = u.pathname.match(PREVIEW_RE);
      if (m) return Number(m[1]);
    } catch {
      // unparsable referrer — ignore
    }
  }
  return null;
}

/**
 * The window to proxy through. Path mode: the app window itself (it holds
 * the daemon connection). Origin mode: the app window is another origin we
 * cannot reach — the companion iframe it embeds on THIS origin relays for
 * it, and is the only client here that isn't the previewed app.
 */
async function findBridge() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (ORIGIN_MODE) {
    return all.find((c) => new URL(c.url).pathname.startsWith("/__clawdot/")) || null;
  }
  const windows = all.filter((c) => !new URL(c.url).pathname.startsWith("/preview/"));
  return windows.find((c) => c.focused) || windows[0] || null;
}

/**
 * `url` set = an allowlisted external fetch; absent = loopback `port`+`path`.
 * `pagePort` is the previewed page's own port (defaults to the target port —
 * they differ only for cross-origin requests to a second loopback port); the
 * daemon uses it to make Origin/Referer look like local browsing.
 */
async function forward(event, port, path, url, pagePort = port) {
  const bridge = await findBridge();
  if (!bridge) {
    return new Response("clawdot preview: no app window to proxy through", {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }

  const request = event.request;
  const headers = [...request.headers.entries()];
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) body = b64encode(new Uint8Array(buf));
  }

  const channel = new MessageChannel();
  const isDocument =
    request.destination === "document" || request.destination === "iframe";
  const response = receive(channel.port1, port, isDocument);
  bridge.postMessage(
    {
      type: "clawdot.fetch",
      port,
      method: request.method,
      path,
      headers,
      body,
      url,
      pagePort,
    },
    [channel.port2],
  );
  return response;
}

/**
 * Assemble the streamed reply (head / chunk / end / error) into a Response.
 * HTML documents are buffered whole so the WebSocket shim can be injected
 * (service workers cannot intercept WebSockets — the shim routes them through
 * the same bridge); everything else streams straight through.
 */
function receive(port, previewPort, isDocument) {
  return new Promise((resolve) => {
    let controller = null; // body stream, once the Response has resolved
    let htmlParts = null; // buffered document body awaiting shim injection
    let bufferedHead = null;
    const headTimer = setTimeout(() => {
      port.close();
      resolve(
        new Response("clawdot preview: timed out waiting for the daemon", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      );
    }, HEAD_TIMEOUT_MS);

    port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "head") {
        clearTimeout(headTimer);
        const headers = new Headers();
        for (const [name, value] of msg.headers) {
          // Keep redirects inside the preview prefix, wherever they point.
          if (name.toLowerCase() === "location") {
            headers.append(name, rewriteLocation(value, previewPort));
          } else {
            headers.append(name, value);
          }
        }
        const isHtml = (headers.get("content-type") || "").includes("text/html");
        if (isDocument && isHtml && msg.status === 200) {
          htmlParts = [];
          bufferedHead = { status: msg.status, headers };
          return; // resolve on end, with the shim injected
        }
        // These statuses must not carry a body, per the Response constructor.
        const nullBody = msg.status === 204 || msg.status === 205 || msg.status === 304;
        const stream = nullBody
          ? null
          : new ReadableStream({
              start(c) {
                controller = c;
              },
              cancel() {
                // The viewer navigated away mid-download — tell the daemon.
                port.postMessage({ type: "cancel" });
                port.close();
              },
            });
        resolve(new Response(stream, { status: msg.status, headers: headers }));
      } else if (msg.type === "chunk") {
        const bytes = b64decode(msg.data);
        if (htmlParts) htmlParts.push(bytes);
        else if (controller) controller.enqueue(bytes);
      } else if (msg.type === "end") {
        if (htmlParts) {
          resolve(
            new Response(injectShim(concat(htmlParts), previewPort), bufferedHead),
          );
        } else if (controller) {
          controller.close();
        }
        port.close();
      } else if (msg.type === "error") {
        clearTimeout(headTimer);
        if (controller) {
          controller.error(new Error(msg.message));
        } else {
          resolve(
            new Response(`clawdot preview: ${msg.message}`, {
              status: 502,
              headers: { "content-type": "text/plain" },
            }),
          );
        }
        port.close();
      }
    };
  });
}

/**
 * Point a Location header back into the preview. Path mode: same-origin
 * absolute paths and URLs targeting the previewed localhost port both
 * become /preview/<port>/… so the browser's follow-up lands in the proxy
 * again. Origin mode: same-origin paths are already right — only absolute
 * redirects to the previewed localhost port need mapping onto this origin.
 */
function rewriteLocation(value, previewPort) {
  try {
    const u = new URL(value, self.location.origin);
    const samePrefix = u.origin === self.location.origin;
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const targetPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (ORIGIN_MODE) {
      if (!samePrefix && isLocal && targetPort === previewPort) {
        return `${u.pathname}${u.search}${u.hash}`;
      }
      return value;
    }
    if (
      (samePrefix && !u.pathname.startsWith("/preview/")) ||
      (isLocal && targetPort === previewPort)
    ) {
      return `/preview/${previewPort}${u.pathname}${u.search}${u.hash}`;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * Insert the WebSocket shim right after <head> (or prepend without one).
 * The port rides along as a global: on the fixed preview origin neither the
 * document's hostname nor its path carries it, so the shim can't re-derive
 * what this worker already resolved.
 */
function injectShim(bytes, port) {
  const tag = `<script>window.__clawdotPreviewPort=${Number(port)}</script>${SHIM_TAG}`;
  const text = new TextDecoder().decode(bytes);
  const head = text.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index + head[0].length;
    return text.slice(0, at) + tag + text.slice(at);
  }
  return tag + text;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(text) {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
