import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  decodeClient,
  encodeServer,
  type ServerMessage,
} from "@clawdot/protocol";

// Match the relay link's heartbeat so zombie connections from crashed browser
// tabs are cleaned up after sleep instead of lingering until the next write.
const LOCAL_HEARTBEAT_INTERVAL_MS = 30_000;
import { CookieJar } from "./cookies.js";
import { PushNotifier } from "./notifications.js";
import { PreviewProxy } from "./preview.js";
import { ConfigStore, WorkspaceStore } from "./store.js";
import {
  openTerminal,
  TerminalRegistry,
  type TerminalHandle,
} from "./terminal.js";
import { RelayLink, TunnelService, type ChannelHandler } from "./tunnel.js";

/** Seed for the settings dialog — only used while config.json has no list. */
const DEFAULT_TERMINAL_AGENTS = [
  { name: "Claude Code", command: "claude" },
  { name: "Codex", command: "codex" },
];

/** True for directories and symlinks that resolve to one (statSync follows). */
function resolvesToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // broken symlink or unreadable
  }
}

/**
 * Windows drive roots ("C:\", "D:\", …). The picker walks up via `parent`,
 * which dead-ends at one drive's root — fs.list carries these so it can offer
 * a volume switcher. Probing the 26 letters is microseconds per existing
 * check and a fast error for absent ones.
 */
function listVolumes(): string[] | undefined {
  if (process.platform !== "win32") return undefined;
  const volumes: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) volumes.push(root);
  }
  return volumes;
}

/** Non-hidden subdirectories of a path, for the workspace picker. */
function listDirs(rawPath: string): ServerMessage {
  let path;
  let entries;
  try {
    path = realpathSync(resolve(rawPath));
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    return {
      type: "fs.error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const dirs = entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        (e.isDirectory() ||
          (e.isSymbolicLink() && resolvesToDirectory(join(path, e.name)))),
    )
    .map((e) => ({ name: e.name, path: join(path, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return {
    type: "fs.list",
    path,
    parent: parent === path ? null : parent,
    dirs,
    volumes: listVolumes(),
  };
}

interface ConnectionContext {
  workspaces: WorkspaceStore;
  clients: ConnectionHub;
  tunnel: TunnelService | null;
  /** Persistent terminal sessions (daemon-scoped, survive disconnects). */
  registry: TerminalRegistry;
  config: ConfigStore;
  /**
   * Daemon-wide (not per-connection): previewed apps' sessions must survive
   * the constant reconnects of a phone, or every screen lock logs the user
   * out of the app they're previewing.
   */
  previewCookies: CookieJar;
}

/** The stored preview allowlist, normalized for case-insensitive matching. */
function previewAllowedHosts(config: ConfigStore): string[] {
  return [
    ...new Set(
      (config.get().previewAllowedHosts ?? [])
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function settingsMessage(config: ConfigStore): ServerMessage {
  const cfg = config.get();
  return {
    type: "settings",
    terminalAgents: cfg.terminalAgents ?? DEFAULT_TERMINAL_AGENTS,
    previewAllowedHosts: previewAllowedHosts(config),
    notifyOnBell: cfg.notifyOnBell ?? true,
  };
}

/** All authenticated local and relay clients currently attached to the daemon. */
class ConnectionHub {
  private readonly clients = new Set<(text: string) => void>();

  add(send: (text: string) => void): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  broadcast(msg: ServerMessage): void {
    const text = encodeServer(msg);
    for (const send of this.clients) send(text);
  }
}

/**
 * One attached client — local WebSocket or authenticated relay channel; both
 * speak the identical schema-validated protocol. The transport hands us
 * decoded text in and takes encoded text out; everything else lives here.
 *
 * `local` is the only privilege split: local connections may mint pairing
 * tickets and manage trusted devices, remote ones must never (a stolen phone
 * could otherwise invite more devices or revoke yours).
 *
 * `deviceKey` is the authenticated device (base64url public key) on a remote
 * channel, or null for a local connection — it's what notify.register binds a
 * push token to.
 */
function createConnection(
  ctx: ConnectionContext,
  rawSend: (text: string) => void,
  opts: { local: boolean; deviceKey: string | null },
): ChannelHandler {
  // Ephemeral PTYs this connection opened. Output goes only to this
  // connection, and the shells die with it — no orphans after a phone
  // disappears.
  const terminals = new Map<string, TerminalHandle>();
  // Subscriptions to persistent terminals; detached (not killed) on close.
  const attached = new Map<string, () => void>();
  // Whether this client's app is foregrounded. A backgrounded viewer still
  // gets attention notifications (terminal.presence toggles this).
  let foreground = true;
  const removeClient = ctx.clients.add(rawSend);

  const send = (msg: ServerMessage) => rawSend(encodeServer(msg));

  // HTTP/WebSocket forwarding for the web preview; in-flight work is owned
  // by this connection and dies with it. The allowlist is read live so a
  // settings change applies to connections that already exist.
  const preview = new PreviewProxy(
    send,
    () => previewAllowedHosts(ctx.config),
    ctx.previewCookies,
  );

  const handleMessage = async (data: string): Promise<void> => {
    const msg = decodeClient(data);
    if (!msg) {
      send({ type: "error", message: "invalid message" });
      return;
    }

    switch (msg.type) {
      case "workspace.list": {
        send({ type: "workspace.list", workspaces: ctx.workspaces.list() });
        break;
      }
      case "workspace.add": {
        ctx.workspaces.record(msg.cwd);
        send({ type: "workspace.list", workspaces: ctx.workspaces.list() });
        break;
      }
      case "workspace.remove": {
        // The store broadcasts the updated list via onChange; answer the
        // requester directly too so a no-op removal still gets a response.
        ctx.workspaces.remove(msg.cwd);
        send({ type: "workspace.list", workspaces: ctx.workspaces.list() });
        break;
      }
      case "fs.list": {
        send(listDirs(msg.path ?? homedir()));
        break;
      }
      case "fs.mkdir": {
        // The name must stay a single path segment under msg.path.
        if (basename(msg.name) !== msg.name || msg.name.startsWith(".")) {
          send({ type: "fs.error", message: `invalid folder name: ${msg.name}` });
          return;
        }
        const target = join(resolve(msg.path), msg.name);
        try {
          mkdirSync(target);
        } catch (err) {
          send({
            type: "fs.error",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        send(listDirs(target));
        break;
      }
      case "terminal.open": {
        const title = msg.title ?? msg.command ?? "Shell";
        try {
          if (msg.persistent) {
            // Spawn only — the client subscribes with terminal.attach, which
            // also serves a view created on a completely different device.
            const meta = ctx.registry.open({
              cwd: msg.cwd,
              cols: msg.cols,
              rows: msg.rows,
              command: msg.command,
              title,
              now: Date.now(),
            });
            ctx.workspaces.record(meta.cwd);
            send({
              type: "terminal.opened",
              terminalId: meta.terminalId,
              title: meta.title,
              cwd: meta.cwd,
              persistent: true,
            });
            break;
          }
          const term = openTerminal({
            cwd: msg.cwd,
            cols: msg.cols,
            rows: msg.rows,
            command: msg.command,
            onData: (data) =>
              send({ type: "terminal.data", terminalId: term.id, data }),
            onExit: (exitCode) => {
              // kill() also lands here — only announce exits we didn't cause.
              if (terminals.delete(term.id)) {
                send({ type: "terminal.exit", terminalId: term.id, exitCode });
              }
            },
          });
          terminals.set(term.id, term);
          send({
            type: "terminal.opened",
            terminalId: term.id,
            title,
            cwd: term.cwd,
            persistent: false,
          });
        } catch (err) {
          send({
            type: "terminal.error",
            terminalId: null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case "terminal.attach": {
        // Re-attaching replaces the old subscription — the client started a
        // fresh view, double-streaming into it would corrupt the replay.
        attached.get(msg.terminalId)?.();
        // The snapshot resolves asynchronously and live output arriving in
        // the meantime is NOT part of it — hold that output back so the
        // client always sees: attached, snapshot, then the live tail.
        let pending: string[] | null = [];
        let pendingExit: number | null = null;
        let takenOver = false;
        const sub = ctx.registry.attach(
          msg.terminalId,
          msg.cols,
          msg.rows,
          {
            onData: (data) => {
              if (pending) pending.push(data);
              else send({ type: "terminal.data", terminalId: msg.terminalId, data });
            },
            onExit: (exitCode) => {
              attached.delete(msg.terminalId);
              if (pending) pendingExit = exitCode;
              else send({ type: "terminal.exit", terminalId: msg.terminalId, exitCode });
            },
            onTakenOver: () => {
              attached.delete(msg.terminalId);
              // Mid-snapshot the client hasn't seen terminal.attached yet —
              // answer its attach with busy instead of an orphaned replay.
              if (pending) takenOver = true;
              else send({ type: "terminal.busy", terminalId: msg.terminalId });
            },
            // Backgrounded viewers count as not-watching for notifications.
            isForeground: () => foreground,
          },
          msg.takeover ?? false,
        );
        if (sub === null) {
          send({
            type: "terminal.error",
            terminalId: msg.terminalId,
            message: "terminal is gone",
          });
          break;
        }
        if (sub === "busy") {
          send({ type: "terminal.busy", terminalId: msg.terminalId });
          break;
        }
        attached.set(msg.terminalId, sub.detach);
        void sub.snapshot.then((snapshot) => {
          if (takenOver) {
            send({ type: "terminal.busy", terminalId: msg.terminalId });
            return;
          }
          send({
            type: "terminal.attached",
            terminalId: msg.terminalId,
            title: sub.meta.title,
            cwd: sub.meta.cwd,
          });
          if (snapshot) {
            send({ type: "terminal.data", terminalId: msg.terminalId, data: snapshot });
          }
          const tail = pending ?? [];
          pending = null;
          for (const data of tail) {
            send({ type: "terminal.data", terminalId: msg.terminalId, data });
          }
          if (pendingExit !== null) {
            send({
              type: "terminal.exit",
              terminalId: msg.terminalId,
              exitCode: pendingExit,
            });
          }
        });
        break;
      }
      case "terminal.detach": {
        attached.get(msg.terminalId)?.();
        attached.delete(msg.terminalId);
        break;
      }
      case "terminal.seen": {
        ctx.registry.markSeen(msg.terminalId);
        break;
      }
      case "terminal.presence": {
        foreground = msg.foreground;
        // Drop foreground devices from push targets so the user isn't pushed
        // about a background terminal while they're looking at the app.
        if (opts.deviceKey) ctx.tunnel?.setForeground(opts.deviceKey, msg.foreground);
        break;
      }
      case "terminal.list": {
        send({ type: "terminal.list", terminals: ctx.registry.list() });
        break;
      }
      case "terminal.input": {
        // Unknown ids are races (input sent as the shell exited), not errors.
        (terminals.get(msg.terminalId) ?? ctx.registry.get(msg.terminalId))?.write(
          msg.data,
        );
        break;
      }
      case "terminal.resize": {
        (terminals.get(msg.terminalId) ?? ctx.registry.get(msg.terminalId))?.resize(
          msg.cols,
          msg.rows,
        );
        break;
      }
      case "terminal.close": {
        const term = terminals.get(msg.terminalId);
        if (term) {
          terminals.delete(msg.terminalId);
          term.kill();
        } else {
          ctx.registry.close(msg.terminalId);
        }
        break;
      }
      case "preview.fetch": {
        preview.fetch(msg);
        break;
      }
      case "preview.abort": {
        preview.abort(msg.requestId);
        break;
      }
      case "preview.ws.open": {
        preview.wsOpen(msg);
        break;
      }
      case "preview.ws.send": {
        preview.wsSend(msg.socketId, msg.data, msg.binary);
        break;
      }
      case "preview.ws.close": {
        preview.wsClose(msg.socketId, msg.code);
        break;
      }
      case "settings.get": {
        send(settingsMessage(ctx.config));
        break;
      }
      case "settings.update": {
        ctx.config.update({
          terminalAgents: msg.terminalAgents,
          ...(msg.previewAllowedHosts !== undefined
            ? {
                previewAllowedHosts: msg.previewAllowedHosts
                  .map((host) => host.trim().toLowerCase())
                  .filter(Boolean),
              }
            : {}),
          ...(msg.notifyOnBell !== undefined ? { notifyOnBell: msg.notifyOnBell } : {}),
        });
        ctx.clients.broadcast(settingsMessage(ctx.config));
        break;
      }
      case "notify.register": {
        // Only a paired (remote) device has an identity to bind a token to; a
        // local browser connection has no push channel anyway.
        if (!opts.deviceKey || !ctx.tunnel) {
          send({ type: "error", message: "notifications require a paired device" });
          return;
        }
        ctx.tunnel.setPushToken(opts.deviceKey, msg.token, msg.platform);
        break;
      }
      case "notify.unregister": {
        if (opts.deviceKey && ctx.tunnel) ctx.tunnel.clearPushToken(opts.deviceKey);
        break;
      }
      case "pair.start": {
        if (!opts.local) {
          send({ type: "error", message: "pairing can only be started locally" });
          return;
        }
        if (!ctx.tunnel) {
          send({
            type: "error",
            message: "relay disabled — start the daemon with --relay <wss-url>",
          });
          return;
        }
        const { ticket, url, expiresAt } = ctx.tunnel.startPairing({
          unlimited: ctx.config.get().unlimitedPairing ?? false,
        });
        send({
          type: "pair.ticket",
          ticket,
          url,
          relayUrl: ctx.tunnel.relayUrl,
          expiresAt,
        });
        break;
      }
      case "device.list":
      case "device.revoke": {
        if (!opts.local) {
          send({ type: "error", message: "devices can only be managed locally" });
          return;
        }
        if (!ctx.tunnel) {
          send({ type: "device.list", devices: [] });
          return;
        }
        if (msg.type === "device.revoke") ctx.tunnel.revokeDevice(msg.key);
        send({ type: "device.list", devices: ctx.tunnel.listDevices() });
        break;
      }
    }
  };

  return {
    handleMessage: (data) => void handleMessage(data),
    handleClose: () => {
      removeClient();
      preview.dispose();
      // A vanished client isn't foreground — let it receive pushes again.
      if (opts.deviceKey) ctx.tunnel?.setForeground(opts.deviceKey, false);
      for (const detach of attached.values()) detach();
      attached.clear();
      const open = [...terminals.values()];
      terminals.clear(); // before kill, so onExit doesn't echo into a dead socket
      for (const term of open) term.kill();
    },
  };
}

export function startServer(opts: {
  port: number;
  cwd: string;
  dataDir: string;
  /** Relay endpoint (wss://host/v1); null disables remote access. */
  relayUrl: string | null;
}): void {
  const workspaces = new WorkspaceStore(opts.dataDir);
  const clients = new ConnectionHub();
  // The directory the daemon was started from is a known workspace — except
  // the home directory, which is just where background services live (the
  // launchd/systemd service runs with cwd=$HOME); recording it would
  // resurrect it on every restart after the user removed it.
  if (resolve(opts.cwd) !== homedir()) workspaces.record(opts.cwd);

  workspaces.onChange(() => {
    clients.broadcast({ type: "workspace.list", workspaces: workspaces.list() });
  });

  const registry = new TerminalRegistry();
  registry.onCatalogChange(() => {
    clients.broadcast({ type: "terminal.list", terminals: registry.list() });
  });

  const tunnel = opts.relayUrl ? new TunnelService(opts.dataDir, opts.relayUrl) : null;
  const config = new ConfigStore(opts.dataDir);
  // Open (or revoke) the never-expiring reviewer pairing token to match config.
  tunnel?.setUnlimitedPairing(config.get().unlimitedPairing ?? false);
  const ctx: ConnectionContext = {
    workspaces,
    clients,
    tunnel,
    registry,
    config,
    previewCookies: new CookieJar(),
  };

  // An unwatched agent ringing the bell becomes a push to every registered
  // device — but only with a relay (the push rides its socket) and only while
  // notifyOnBell is on. relayLink is filled in below; the notifier reads it
  // lazily so the wiring order doesn't matter.
  let relayLink: RelayLink | null = null;
  const notifier =
    tunnel &&
    new PushNotifier({
      tunnel,
      send: (msg) => relayLink?.sendControl(msg),
      enabled: () => config.get().notifyOnBell ?? true,
    });
  // The in-app attention dot rides the catalog (TerminalMeta.needsAttention,
  // set in the registry); this listener only adds the push, when a relay exists.
  if (notifier) registry.onAttentionNeeded((meta) => notifier.notify(meta));

  const wss = new WebSocketServer({ port: opts.port });
  wss.on("connection", (ws: WebSocket) => {
    const connection = createConnection(
      ctx,
      (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      { local: true, deviceKey: null },
    );
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, LOCAL_HEARTBEAT_INTERVAL_MS);
    ws.on("pong", () => { alive = true; });
    ws.on("message", (data) => connection.handleMessage(data.toString()));
    ws.on("close", () => {
      clearInterval(heartbeat);
      connection.handleClose();
    });
  });

  if (tunnel) {
    relayLink = new RelayLink({
      tunnel,
      attach: (send, deviceKey) =>
        createConnection(ctx, send, { local: false, deviceKey }),
      onPushDead: (tokens) => tunnel.prunePushTokens(tokens),
    });
    relayLink.start();
  }

  console.log(`clawdot daemon listening on ws://localhost:${opts.port}`);
  console.log(`working directory: ${opts.cwd}`);
  console.log(`data dir: ${opts.dataDir}`);
  if (!tunnel) {
    console.log(
      "relay: not configured — remote access is off. Point the daemon at your relay once with --relay wss://<your-host>/v1 (it will be remembered).",
    );
  }
}

export type { WebSocket };
