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
