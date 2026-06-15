/** Shared bits for the interactive commands (setup, config, devices, pair). */
import * as p from "@clack/prompts";

/** Interactive commands need a terminal — fail loudly instead of hanging. */
export function requireTty(command: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`clawdot ${command} is interactive — run it in a terminal`);
    process.exit(1);
  }
}

/** Ctrl-C inside a prompt: say goodbye and leave cleanly. */
export function bailIfCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was changed.");
    process.exit(0);
  }
}

export function validateRelayUrl(value: string | undefined): string | undefined {
  if (value && !/^wss?:\/\/.+/.test(value)) {
    return "must start with ws:// or wss:// (e.g. wss://your-domain/v1)";
  }
  return undefined;
}

export function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "must be a port number (1–65535)";
  }
  return undefined;
}

/** GET the relay's /healthz (derived from the ws URL). */
export async function relayReachable(relayUrl: string): Promise<boolean> {
  try {
    const url = new URL(relayUrl);
    const proto = url.protocol === "wss:" ? "https:" : "http:";
    const res = await fetch(`${proto}//${url.host}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
