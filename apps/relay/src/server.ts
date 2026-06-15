/**
 * The clawdot relay — a deliberately dumb, self-hostable ciphertext pipe.
 *
 * One daemon and any number of clients meet in a "room" (an opaque id derived
 * from the daemon's public key). The relay bridges them:
 *
 *   client socket  ── bare binary frames ──┐
 *                                          ├── relay ──► daemon socket
 *   client socket  ── bare binary frames ──┘    (4-byte channel id prefix)
 *
 * Every payload is end-to-end ciphertext. The relay holds no keys, parses no
 * protocol messages, and persists nothing — compromising it yields traffic
 * metadata at most. Keep it that way: any feature that needs plaintext
 * belongs in the daemon or the client, never here.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  RELAY_PATH,
  decodeDaemonRelayControl,
  decodeRelayHello,
  packChannelFrame,
  unpackChannelFrame,
  type RelayClientControl,
  type RelayDaemonControl,
} from "@clawdot/protocol/tunnel";
import type { FcmSender } from "./fcm.js";

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_CLIENTS_PER_ROOM = 32;
const MAX_ROOMS = 4096;

interface Room {
  daemon: WebSocket | null;
  clients: Map<number, WebSocket>;
  nextChannel: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * Serve the built web app (single-page: unknown paths fall back to
 * index.html so pairing links and future routes work). Static hosting keeps
 * the VPS deploy to one container; it gives this host no new powers — it
 * already serves the page, and the E2E layer doesn't trust the page's server
 * with any secrets (tickets travel in URL fragments, keys stay client-side).
 */
function serveStatic(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://relay").pathname);
  let filePath = resolve(rootDir, "." + pathname);
  // resolve() collapsed any ".."; anything outside the root is a traversal try
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(404).end();
    return;
  }
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(filePath)) filePath = resolve(rootDir, "index.html");
  if (!isFile(filePath)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/** Normalize a ws RawData value to a single Uint8Array. */
function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data; // includes Buffer
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data as Uint8Array[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  return new Uint8Array(0);
}

export function startRelay(opts: {
  port: number;
  host?: string;
  /** Directory with the built web app to serve; omit for websocket-only. */
  staticDir?: string;
  maxPayloadBytes?: number;
  maxClientsPerRoom?: number;
  maxRooms?: number;
  /**
   * Sends push notifications when the daemon asks (push.send). The relay's one
   * exception to "ciphertext only" — see fcm.ts. Omit/null to disable push.
   */
  fcm?: FcmSender | null;
}): Server {
  const fcm = opts.fcm ?? null;
  const maxClientsPerRoom = opts.maxClientsPerRoom ?? MAX_CLIENTS_PER_ROOM;
  const maxRooms = opts.maxRooms ?? MAX_ROOMS;
  const rooms = new Map<string, Room>();
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
  if (staticDir && !existsSync(staticDir)) {
    throw new Error(`--static directory does not exist: ${staticDir}`);
  }

  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (staticDir) {
      serveStatic(staticDir, req, res);
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: http,
    path: RELAY_PATH,
    maxPayload: opts.maxPayloadBytes ?? MAX_PAYLOAD_BYTES,
  });

  const toClient = (ws: WebSocket, msg: RelayClientControl) =>
    ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const toDaemon = (ws: WebSocket, msg: RelayDaemonControl) =>
    ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  const closeClient = (ws: WebSocket, reason: string) => {
    toClient(ws, { type: "close", reason });
    ws.close();
  };

  /**
   * Emit a push the daemon asked for. Fire-and-forget: the daemon socket isn't
   * blocked on Google, and any tokens FCM rejects as permanently gone are
   * reported back so the daemon prunes them. Nothing is stored here.
   */
  const handlePush = (ws: WebSocket, tokens: string[], title: string, body: string) => {
    if (!fcm) return; // push not configured on this relay — silently ignore
    void fcm
      .send(tokens, title, body)
      .then((result) => {
        if (result.dead.length) toDaemon(ws, { type: "push.dead", tokens: result.dead });
      })
      .catch((err) => console.warn(`relay: push failed: ${err}`));
  };

  wss.on("connection", (ws) => {
    let bound = false;
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    // A socket that never identifies itself is dropped.
    const helloTimer = setTimeout(() => {
      if (!bound) ws.close();
    }, HELLO_TIMEOUT_MS);
    ws.once("close", () => clearTimeout(helloTimer));

    ws.once("message", (data, isBinary) => {
      const hello = isBinary ? null : decodeRelayHello(data.toString());
      if (!hello) {
        ws.close();
        return;
      }
      bound = true;
      if (hello.role === "daemon") bindDaemon(ws, hello.room);
      else bindClient(ws, hello.room);
    });
  });

  function bindDaemon(ws: WebSocket, roomId: string): void {
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= maxRooms) {
        ws.close();
        return;
      }
      room = { daemon: null, clients: new Map(), nextChannel: 1 };
      rooms.set(roomId, room);
    }
    // A reconnecting daemon (restart, network change) reclaims its room.
    room.daemon?.close();
    room.daemon = ws;
    console.log(`daemon joined room ${roomId}`);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        // The only daemon → relay control message: a request to emit a push.
        const control = decodeDaemonRelayControl(data.toString());
        if (control?.type === "push.send") handlePush(ws, control.tokens, control.title, control.body);
        return;
      }
      const frame = unpackChannelFrame(asBytes(data));
      if (!frame) return;
      const client = room.clients.get(frame.ch);
      if (client && client.readyState === WebSocket.OPEN) client.send(frame.payload);
    });

    ws.on("close", () => {
      if (room.daemon !== ws) return; // replaced by a newer connection
      room.daemon = null;
      for (const client of room.clients.values()) closeClient(client, "daemon-gone");
      room.clients.clear();
      rooms.delete(roomId);
      console.log(`daemon left room ${roomId}`);
    });
  }

  function bindClient(ws: WebSocket, roomId: string): void {
    const room = rooms.get(roomId);
    const daemon = room?.daemon;
    if (!room || !daemon || daemon.readyState !== WebSocket.OPEN) {
      closeClient(ws, "daemon-offline");
      return;
    }
    if (room.clients.size >= maxClientsPerRoom) {
      closeClient(ws, "room-full");
      return;
    }
    const ch = room.nextChannel++;
    room.clients.set(ch, ws);
    toDaemon(daemon, { type: "channel.open", ch });
    toClient(ws, { type: "ready" });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      if (daemon.readyState === WebSocket.OPEN) {
        daemon.send(packChannelFrame(ch, asBytes(data)));
      }
    });

    ws.on("close", () => {
      if (room.clients.get(ch) !== ws) return;
      room.clients.delete(ch);
      if (room.daemon?.readyState === WebSocket.OPEN) {
        toDaemon(room.daemon, { type: "channel.close", ch });
      }
    });
  }

  // Keep NAT mappings warm and reap dead sockets.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        ws.terminate();
        continue;
      }
      live.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(pinger));

  http.listen(opts.port, opts.host, () => {
    console.log(
      `clawdot relay listening on ${opts.host ?? "0.0.0.0"}:${opts.port}${RELAY_PATH}`,
    );
    if (staticDir) console.log(`serving web app from ${staticDir}`);
    console.log(
      fcm
        ? `push notifications enabled (FCM project ${fcm.projectId})`
        : "push notifications disabled (set FCM_SERVICE_ACCOUNT_FILE to enable)",
    );
  });
  return http;
}
