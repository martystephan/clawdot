/**
 * Clawdot preview companion (origin mode).
 *
 * Loaded as a hidden iframe at p<port>.<app-host>/__clawdot/preview-bridge.html
 * by the app window. The preview origin's service worker can only message
 * clients of its own origin, and the daemon connection lives in the app
 * window on the apex origin — this page is the relay between them:
 *
 *   preview-sw.js ──client message──► companion ──MessagePort──► app bridge
 *   app bridge ──MessagePort──► companion ──registration message──► sw
 *
 * It also registers the service worker for this origin and tells the app
 * when the worker is active — only then may the app load the preview
 * iframe, or the relay's SPA fallback would answer instead of the proxy.
 *
 * Plain JS by design: served as-is from public/, no bundler involved.
 */
(() => {
  "use strict";
  const m = location.hostname.match(/^(p\d{1,5}|preview)\./);
  if (!m || window.parent === window) return;
  // The app window's origin: this host minus the preview label.
  const appOrigin =
    location.protocol + "//" + location.host.replace(/^(p\d{1,5}|preview)\./, "");
  // On the fixed preview.<host> origin the hostname can't carry the port —
  // the app passes it in this page's URL, and this page is its source of
  // truth for the worker (pushed after registration, answered on query).
  const portParam = Number(new URLSearchParams(location.search).get("port"));
  const previewPort =
    Number.isInteger(portParam) && portParam > 0 && portParam < 65536
      ? portParam
      : null;

  /** MessagePort to the app's preview bridge, once it introduces itself. */
  let appPort = null;

  // SW → app: intercepted fetches and allowlist queries arrive with their
  // reply MessagePorts attached; re-transfer them up the channel untouched.
  // Port queries are answered right here — the app doesn't know more.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.type === "clawdot.port.get") {
        e.ports[0]?.postMessage(previewPort);
        return;
      }
      if (appPort && d && typeof d.type === "string") {
        appPort.postMessage(d, [...e.ports]);
      }
    });
    navigator.serviceWorker.startMessages();
  }

  // The app initiates: it posts one MessagePort that becomes the channel
  // for everything. Only the apex origin may drive this page.
  window.addEventListener("message", (e) => {
    if (e.origin !== appOrigin) return;
    const d = e.data;
    if (!d || d.type !== "clawdot.companion.init") return;
    const port = e.ports[0];
    if (!port) return;
    appPort = port;
    port.onmessage = (ev) => {
      const msg = ev.data;
      // App → SW (allowlist pushes), relayed via the registration.
      if (msg && msg.type === "clawdot.allowlist" && "serviceWorker" in navigator) {
        void navigator.serviceWorker.ready.then((reg) => {
          reg.active?.postMessage(msg);
        });
      }
    };

    if (!("serviceWorker" in navigator)) {
      port.postMessage({
        type: "clawdot.companion.error",
        message: "service workers unavailable on this origin",
      });
      return;
    }
    void navigator.serviceWorker
      .register("/preview-sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Tell the worker which port this origin previews BEFORE the app
        // loads the preview iframe (a worker restart re-queries instead).
        if (previewPort !== null) {
          reg.active?.postMessage({ type: "clawdot.port", port: previewPort });
        }
        port.postMessage({ type: "clawdot.companion.ready" });
      })
      .catch((err) =>
        port.postMessage({
          type: "clawdot.companion.error",
          message: String(err),
        }),
      );
  });
})();
