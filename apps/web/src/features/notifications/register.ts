/**
 * Push-notification registration for the native (Tauri) shell.
 *
 * Only the native build can receive push: it embeds the Firebase SDK, which
 * mints an FCM registration token after the OS grants notification permission.
 * In a plain browser there is no token to get, so every entry point here is a
 * no-op. The token is handed to the daemon over the E2E tunnel
 * (notify.register); the daemon stores it against this device and asks the
 * relay to emit a push when an agent needs attention while the app is closed.
 */
import type { PushPlatform } from "@clawdot/protocol";

/** True only inside the Tauri shell (same probe daemonUrl() uses). */
function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export interface PushRegistration {
  token: string;
  platform: PushPlatform;
}

/**
 * How long to keep asking the native layer for a token. A FIRST launch can be
 * slow: iOS does APNs registration, then Firebase exchanges that for an FCM
 * token — easily 10-30 s, and longer if the network is poor. 8 s (the old
 * window) routinely missed it, leaving the device unregistered until a
 * reconnect that might never come. Poll generously instead.
 */
const TOKEN_POLL_TIMEOUT_MS = 120_000;
const TOKEN_POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the native layer for the device's FCM token, requesting notification
 * permission on first call. Returns null when push is unavailable (browser,
 * permission denied, or Firebase not configured in the native build). The
 * token arrives asynchronously after launch, so we poll until it shows up
 * (up to TOKEN_POLL_TIMEOUT_MS) rather than give up on the first empty read.
 */
export async function acquirePushToken(): Promise<PushRegistration | null> {
  if (!inTauri()) return null;
  let invoke: <T>(cmd: string) => Promise<T>;
  try {
    ({ invoke } = await import("@tauri-apps/api/core"));
  } catch {
    return null;
  }

  const deadline = Date.now() + TOKEN_POLL_TIMEOUT_MS;
  for (;;) {
    let token: string | null = null;
    try {
      token = await invoke<string | null>("get_push_token");
    } catch (err) {
      // Command missing (older shell) or native error — don't keep retrying.
      console.warn("push: get_push_token failed", err);
      return null;
    }
    if (token) return { token, platform: "ios" };
    if (Date.now() >= deadline) return null;
    await sleep(TOKEN_POLL_INTERVAL_MS);
  }
}
