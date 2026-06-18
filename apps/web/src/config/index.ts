/**
 * Daemon WebSocket endpoint for DIRECT (same-network) connections, or null
 * when no direct connection is possible. Defaults to the daemon's well-known
 * port on the host serving the app; override with `?daemon=ws://...` for
 * unusual setups. When a remote link is stored (the device was paired), the
 * app connects through the relay instead.
 *
 * On an HTTPS page (the relay-hosted app) the browser blocks insecure ws://
 * sockets as mixed content — and the relay host doesn't run a daemon anyway —
 * so without an explicit override there is nothing to connect to directly.
 */
export function daemonUrl(): string | null {
  const override = new URLSearchParams(location.search).get("daemon");
  if (override) return override;
  // The Vite dev server pairs with the dev daemon started by `pnpm dev`
  // (port 8788, isolated data dir) — never with an installed daemon that
  // may be running on 8787. Vite strips this branch from production builds.
  if (import.meta.env.DEV) return `ws://${location.hostname}:8788`;
  // Inside the Tauri shell the page is served from the app bundle
  // (tauri://localhost), not from a machine that runs a daemon, so there is
  // no direct endpoint to derive — the app connects through the relay once
  // paired.
  if ("__TAURI_INTERNALS__" in window) return null;
  if (location.protocol === "https:") return null;
  return `ws://${location.hostname}:8787`;
}

/**
 * True only inside the Tauri native shell (the mobile app), where the page is
 * served from the app bundle rather than a browser tab. Features that only make
 * sense in a real browser (e.g. the Fullscreen API) gate on this.
 */
export function isNativeShell(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

const REMOTE_KEY = "clawdot.remote";

/**
 * A paired remote daemon: where its relay is, the daemon key pinned at
 * pairing time, and this device's own identity. The pairing secret itself is
 * never stored — after first contact the device key is the credential.
 */
export interface RemoteLink {
  relayUrl: string;
  /** base64url X25519 public key of the daemon. */
  daemonKey: string;
  /** base64url X25519 secret key of this device. */
  deviceSecret: string;
}

export function loadRemoteLink(): RemoteLink | null {
  const raw = localStorage.getItem(REMOTE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteLink>;
    if (
      typeof parsed.relayUrl === "string" &&
      typeof parsed.daemonKey === "string" &&
      typeof parsed.deviceSecret === "string"
    ) {
      return parsed as RemoteLink;
    }
  } catch {
    // fall through
  }
  return null;
}

export function saveRemoteLink(link: RemoteLink): void {
  localStorage.setItem(REMOTE_KEY, JSON.stringify(link));
}

export function clearRemoteLink(): void {
  localStorage.removeItem(REMOTE_KEY);
}
