import WebSocket from "ws";
import {
  decodeServer,
  encodeClient,
  type ClientMessage,
  type ServerMessage,
} from "@clawdot/protocol";

const TIMEOUT_MS = 5000;

/**
 * Short-lived local-socket client for CLI commands (`pair`, `devices`).
 * Request/response only — streaming sessions are the web app's job.
 */
export class DaemonClient {
  private constructor(private readonly ws: WebSocket) {}

  static connect(port: number): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`no daemon answered on ws://localhost:${port}`));
      }, TIMEOUT_MS);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(new DaemonClient(ws));
      });
      ws.on("error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            `could not reach the daemon on ws://localhost:${port} — is it running? Start it with \`clawdot serve\` (or \`clawdot service install\`).`,
          ),
        );
      });
    });
  }

  /** Send one message and resolve with the first reply of the wanted type. */
  request<T extends ServerMessage["type"]>(
    msg: ClientMessage,
    replyType: T,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("the daemon did not answer in time"));
      }, TIMEOUT_MS);
      const onMessage = (data: WebSocket.RawData) => {
        const parsed = decodeServer(data.toString());
        if (!parsed) return;
        if (parsed.type === replyType) {
          cleanup();
          resolve(parsed as Extract<ServerMessage, { type: T }>);
        } else if (parsed.type === "error") {
          cleanup();
          reject(new Error(parsed.message));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off("message", onMessage);
      };
      this.ws.on("message", onMessage);
      this.ws.send(encodeClient(msg));
    });
  }

  close(): void {
    this.ws.close();
  }
}

type RelayStatusReply = Extract<ServerMessage, { type: "relay.status" }>;

/**
 * Ask the daemon how its outbound relay link is doing. Returns null when the
 * daemon can't be reached or doesn't answer — callers render that as unknown.
 */
export async function fetchRelayStatus(port: number): Promise<RelayStatusReply | null> {
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(port);
  } catch {
    return null;
  }
  try {
    return await client.request({ type: "relay.status" }, "relay.status");
  } catch {
    return null;
  } finally {
    client.close();
  }
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A one-line summary of the relay link, plus whether it's healthy. */
export function describeRelay(r: RelayStatusReply | null): { ok: boolean; text: string } {
  if (!r) return { ok: false, text: "relay status unavailable" };
  if (!r.configured) return { ok: true, text: "not configured — remote access off" };
  if (r.connected) return { ok: true, text: `connected to ${r.relayUrl}` };
  const bits = [r.lastError ?? "connecting"];
  if (r.attempts) bits.push(`${r.attempts} failed attempt${r.attempts === 1 ? "" : "s"}`);
  bits.push(r.lastConnectedAt ? `last ok ${ago(r.lastConnectedAt)}` : "never connected");
  return { ok: false, text: `NOT connected to ${r.relayUrl} — ${bits.join(", ")}` };
}
