/**
 * @clawdot/protocol
 *
 * Shared protocol between Clawdot clients and the daemon.
 *
 * Design rules:
 * - `terminal.*` messages drive interactive terminals (PTYs) on the daemon's
 *   machine. Two lifetimes exist:
 *   - ephemeral (default): owned by the connection that opened it, output
 *     goes only there, and the PTY dies when that connection drops.
 *   - persistent (`persistent: true`): daemon-scoped "terminal sessions"
 *     that run a configured agent command (claude, codex, …) and survive
 *     disconnects — vital on mobile, where locking the phone drops the
 *     socket. They keep a bounded scrollback buffer; `terminal.open` only
 *     spawns, clients subscribe with `terminal.attach` (which replays the
 *     scrollback) and unsubscribe with `terminal.detach`. They do not
 *     survive a daemon restart (a PTY cannot be rehydrated). Exactly ONE
 *     client views a persistent terminal at a time — concurrent viewers
 *     would fight over the PTY size. An attach while another connection is
 *     viewing answers `terminal.busy`; attaching with `takeover: true`
 *     moves the view here and the previous viewer gets `terminal.busy`.
 * - `settings.*` is the remotely-editable subset of the daemon's config.json
 *   (currently: the terminal agent list). Connection-level settings like the
 *   relay URL or port stay local-only — a remote edit could sever the link.
 * - `workspace.*` / `fs.*` exist so phones can pick project directories
 *   without typing absolute paths.
 * - `pair.*` / `device.*` are local-socket-only: remote clients must never
 *   mint tickets or manage trusted devices.
 * - `preview.*` proxies HTTP and WebSocket traffic to servers on the daemon's
 *   machine (loopback by default — the daemon is a port forwarder, not a
 *   general proxy; the one exception is `preview.fetch` with an absolute
 *   `url`, which the daemon serves ONLY for hostnames the user explicitly
 *   allowlisted in settings), so the app can render a live web preview of a
 *   dev server through the same E2E-encrypted connection. The client drives
 *   it: a service worker turns iframe requests into `preview.fetch`, and a
 *   shim injected into preview documents turns their WebSockets (Vite HMR)
 *   into `preview.ws.*`. Bodies travel base64-encoded; responses stream as
 *   head/body/end so large assets never need one giant message.
 * - further `surface.*` events (test panels, …) will be added later and
 *   must never require changes to the transport layer.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 17;

/** An FCM/APNs registration token, as obtained on the device. */
export const PushToken = z.string().min(1).max(4096);
export const PushPlatform = z.enum(["ios", "android", "web"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * A project directory the daemon has opened terminals in (or was started
 * from), as returned by workspace.list. Clients use these as suggestions when
 * opening a workspace — typing absolute paths on a phone is a last resort.
 */
export const WorkspaceMeta = z.object({
  cwd: z.string(),
  lastUsedAt: z.number(),
});
export type WorkspaceMeta = z.infer<typeof WorkspaceMeta>;

/** A directory entry in an fs.list response. */
export const DirEntry = z.object({ name: z.string(), path: z.string() });
export type DirEntry = z.infer<typeof DirEntry>;

/** A paired device, as returned by device.list. `key` is its public key. */
export const DeviceMeta = z.object({
  key: z.string(),
  addedAt: z.number(),
  lastSeenAt: z.number(),
});
export type DeviceMeta = z.infer<typeof DeviceMeta>;

/** A configured command launchable as a terminal session ("Claude Code" → `claude`). */
export const TerminalAgent = z.object({
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(1000),
});
export type TerminalAgent = z.infer<typeof TerminalAgent>;

export const MAX_TERMINAL_AGENTS = 20;

/**
 * A hostname the daemon may fetch for previews beyond loopback ("api.example.com",
 * an IP). Hostname only — it matches any port and any of http/https.
 */
export const PreviewAllowedHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9_]([a-z0-9._-]*[a-z0-9_])?$/i);

export const MAX_PREVIEW_ALLOWED_HOSTS = 50;

/**
 * HTTP headers as ordered name/value pairs (a record can't carry repeated
 * names like multiple `set-cookie`s, and order is occasionally meaningful).
 */
export const HeaderPairs = z.array(
  z.tuple([z.string().max(256), z.string().max(8192)]),
);
export type HeaderPairs = z.infer<typeof HeaderPairs>;

const previewId = z.string().min(1).max(128);
const previewPort = z.number().int().min(1).max(65535);
/** Request path including query string, as the target server should see it. */
const previewPath = z.string().min(1).max(8192).regex(/^\//);

/** A persistent terminal session, as returned by terminal.list. */
export const TerminalMeta = z.object({
  terminalId: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  /**
   * The session rang the bell while unwatched and hasn't been looked at since —
   * drives the in-app attention dot. Daemon-authoritative and part of the
   * catalog, so it survives reconnects and stays consistent across devices.
   * Cleared by terminal.seen when the session is viewed.
   */
  needsAttention: z.boolean(),
});
export type TerminalMeta = z.infer<typeof TerminalMeta>;

// ---------------------------------------------------------------------------
// Client → daemon
// ---------------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace.list") }),
  /** Add a workspace to the daemon's workspace list without spawning a terminal. */
  z.object({ type: z.literal("workspace.add"), cwd: z.string() }),
  /**
   * Forget a workspace. Only drops it from the daemon's workspace list — the
   * directory and any terminals running in it are untouched (a workspace with
   * live sessions reappears the next time one is opened in it). The updated
   * workspace.list is broadcast to every client.
   */
  z.object({ type: z.literal("workspace.remove"), cwd: z.string() }),
  /**
   * Browse directories on the daemon's machine (workspace picker). Omitting
   * `path` lists the daemon user's home directory.
   */
  z.object({ type: z.literal("fs.list"), path: z.string().optional() }),
  /** Create `name` under `path` and reply with an fs.list of the new dir. */
  z.object({
    type: z.literal("fs.mkdir"),
    path: z.string(),
    name: z.string().min(1),
  }),
  /**
   * Open a terminal on the daemon's machine. Replies with terminal.opened
   * (or terminal.error with a null terminalId). An invalid cwd falls back to
   * the daemon user's home directory rather than failing. `command` runs
   * inside the user's shell instead of an interactive shell. Ephemeral
   * terminals stream to the opener immediately; persistent ones only spawn —
   * subscribe with terminal.attach.
   */
  z.object({
    type: z.literal("terminal.open"),
    cwd: z.string().optional(),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
    command: z.string().min(1).max(1000).optional(),
    /** Display name for terminal.list (defaults to the command or "Shell"). */
    title: z.string().min(1).max(100).optional(),
    persistent: z.boolean().optional(),
  }),
  /**
   * Subscribe to a persistent terminal: replies terminal.attached, replays
   * the scrollback as terminal.data, then streams live. Re-attaching
   * replaces the previous subscription (the client starts a fresh view).
   * If another connection is viewing, replies terminal.busy instead unless
   * `takeover` is set — then the view moves here and the previous viewer is
   * told via terminal.busy.
   */
  z.object({
    type: z.literal("terminal.attach"),
    terminalId: z.string(),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
    takeover: z.boolean().optional(),
  }),
  /** Unsubscribe from a persistent terminal without killing it. */
  z.object({ type: z.literal("terminal.detach"), terminalId: z.string() }),
  /**
   * Mark a session's attention as seen (the user opened/viewed it). Clears the
   * daemon's needsAttention flag and broadcasts the updated catalog to every
   * client, so the dot clears everywhere — not just on this device.
   */
  z.object({ type: z.literal("terminal.seen"), terminalId: z.string() }),
  /**
   * The viewing client's foreground state. A backgrounded app (phone locked
   * or switched away) isn't watching even though its viewer is still attached,
   * so the daemon should fire attention notifications for the viewed terminal.
   * Connection-scoped (a connection views at most one terminal); defaults to
   * foreground until told otherwise. Foregrounding suppresses bells again.
   */
  z.object({ type: z.literal("terminal.presence"), foreground: z.boolean() }),
  /** List persistent terminal sessions. */
  z.object({ type: z.literal("terminal.list") }),
  /** Keystrokes (and pastes) for the PTY, as produced by the terminal UI. */
  z.object({
    type: z.literal("terminal.input"),
    terminalId: z.string(),
    data: z.string().max(1_000_000),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: z.string(),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
  }),
  /** Kill the PTY. Closing the connection implicitly closes ephemeral ones. */
  z.object({ type: z.literal("terminal.close"), terminalId: z.string() }),
  /** Read the remotely-editable settings; replies with `settings`. */
  z.object({ type: z.literal("settings.get") }),
  /** Update them; the new `settings` is broadcast to every client. */
  z.object({
    type: z.literal("settings.update"),
    terminalAgents: z.array(TerminalAgent).max(MAX_TERMINAL_AGENTS),
    /** Hosts the preview proxy may fetch beyond loopback. Omitted = keep. */
    previewAllowedHosts: z
      .array(PreviewAllowedHost)
      .max(MAX_PREVIEW_ALLOWED_HOSTS)
      .optional(),
    /** Push a notification when an agent rings the bell while unwatched. Omitted = keep. */
    notifyOnBell: z.boolean().optional(),
  }),
  /**
   * Proxy one HTTP request to loopback `<port><path>` on the daemon's
   * machine. The response streams back as preview.head, then preview.body
   * chunks, then preview.end (or preview.error at any point). In-flight
   * requests die with the connection. With `url` set, the daemon instead
   * fetches that absolute http(s) URL — but only if its hostname is on the
   * user's preview allowlist (settings) — so previewed apps can reach APIs
   * the phone's browser can't (CORS, private networks). `port`/`path` then
   * just carry the preview context.
   */
  z.object({
    type: z.literal("preview.fetch"),
    requestId: previewId,
    port: previewPort,
    method: z.string().min(1).max(20),
    path: previewPath,
    headers: HeaderPairs.max(128),
    /** Absolute target URL for an allowlisted external fetch. */
    url: z.string().url().max(8192).optional(),
    /**
     * The previewed page's own port. The daemon rewrites Origin/Referer to
     * `http://localhost:<pagePort>` — exactly what the target would see if
     * the user browsed locally — so origin-checking backends (Better Auth
     * CSRF checks, CORS allowlists pinned to localhost) behave identically
     * in the preview. Forwarding the real preview-origin headers would trip
     * them; stripping them entirely trips strict ones too.
     */
    pagePort: previewPort.optional(),
    /** base64 request body (uploads, form posts). */
    body: z.string().max(14_000_000).optional(),
  }),
  /** Cancel an in-flight preview.fetch (the viewer navigated away). */
  z.object({ type: z.literal("preview.abort"), requestId: previewId }),
  /**
   * Open a WebSocket to loopback `<port><path>` on the daemon's
   * machine (service workers can't intercept WebSockets, so a shim in the
   * preview document routes them here). Replies preview.ws.opened on
   * success, preview.ws.closed otherwise. Sockets die with the connection.
   */
  z.object({
    type: z.literal("preview.ws.open"),
    socketId: previewId,
    port: previewPort,
    path: previewPath,
    protocols: z.array(z.string().min(1).max(128)).max(16).optional(),
  }),
  /** One WebSocket message toward the target server; data is base64. */
  z.object({
    type: z.literal("preview.ws.send"),
    socketId: previewId,
    data: z.string().max(14_000_000),
    binary: z.boolean(),
  }),
  z.object({
    type: z.literal("preview.ws.close"),
    socketId: previewId,
    code: z.number().int().min(1000).max(4999).optional(),
  }),
  /**
   * Start a pairing window: the daemon mints a one-time secret and replies
   * with pair.ticket. Sent by `clawdot pair` over the local socket; remote
   * (relay) connections must not be able to mint tickets for themselves.
   */
  z.object({ type: z.literal("pair.start") }),
  /** List paired devices. Local socket only, like pair.start. */
  z.object({ type: z.literal("device.list") }),
  /**
   * Revoke a paired device by its public key; replies with the updated
   * device.list. Blocks future handshakes — a currently open connection
   * lasts until it drops. Local socket only.
   */
  z.object({ type: z.literal("device.revoke"), key: z.string() }),
  /**
   * Register this device's push token so the daemon can notify it when an
   * agent needs attention while the app is backgrounded. Carried inside the
   * E2E channel, so the token is associated with the channel's authenticated
   * device — only meaningful on a paired (remote) connection. The daemon
   * stores it in the trusted-device registry and never echoes it back.
   */
  z.object({
    type: z.literal("notify.register"),
    token: PushToken,
    platform: PushPlatform,
  }),
  /** Forget this device's push token (notifications turned off / signed out). */
  z.object({ type: z.literal("notify.unregister") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// Daemon → client
// ---------------------------------------------------------------------------

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workspace.list"),
    workspaces: z.array(WorkspaceMeta),
  }),
  /**
   * Directory listing; `parent` is null at the filesystem root. On Windows
   * `volumes` carries the drive roots ("C:\", "D:\") — walking up via
   * `parent` dead-ends at one drive's root, so the picker needs them to
   * switch volumes; absent on platforms with a single filesystem root.
   */
  z.object({
    type: z.literal("fs.list"),
    path: z.string(),
    parent: z.string().nullable(),
    dirs: z.array(DirEntry),
    volumes: z.array(z.string()).optional(),
  }),
  /** Failure of an fs.* request — scoped so clients can show it in the picker. */
  z.object({ type: z.literal("fs.error"), message: z.string() }),
  /**
   * Response to pair.start. `ticket` is the encoded pairing ticket (relay URL,
   * daemon key, one-time secret); `url` is the QR-friendly web app link with
   * the ticket in the fragment; `expiresAt` is a unix ms deadline.
   */
  z.object({
    type: z.literal("pair.ticket"),
    ticket: z.string(),
    url: z.string(),
    relayUrl: z.string(),
    expiresAt: z.number(),
  }),
  /** Response to device.list / device.revoke. */
  z.object({
    type: z.literal("device.list"),
    devices: z.array(DeviceMeta),
  }),
  /** Response to terminal.open. `cwd` is the directory the shell started in. */
  z.object({
    type: z.literal("terminal.opened"),
    terminalId: z.string(),
    title: z.string(),
    cwd: z.string(),
    persistent: z.boolean(),
  }),
  /** Response to terminal.attach; the scrollback replay follows as terminal.data. */
  z.object({
    type: z.literal("terminal.attached"),
    terminalId: z.string(),
    title: z.string(),
    cwd: z.string(),
  }),
  /**
   * The terminal is being viewed from another connection. Sent in answer to
   * a non-takeover attach that lost, and pushed to a viewer whose terminal
   * was just taken over. Either way: re-attach with takeover to view here.
   */
  z.object({ type: z.literal("terminal.busy"), terminalId: z.string() }),
  /** Response to terminal.list; also broadcast whenever the set changes. */
  z.object({
    type: z.literal("terminal.list"),
    terminals: z.array(TerminalMeta),
  }),
  /** Response to settings.get; broadcast after every settings.update. */
  z.object({
    type: z.literal("settings"),
    terminalAgents: z.array(TerminalAgent),
    /** Hosts the preview proxy may fetch beyond loopback. */
    previewAllowedHosts: z.array(z.string()),
    /** Whether a terminal bell on an unwatched session pushes a notification. */
    notifyOnBell: z.boolean(),
  }),
  /** Raw PTY output — escape sequences included, exactly as the shell wrote it. */
  z.object({
    type: z.literal("terminal.data"),
    terminalId: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("terminal.exit"),
    terminalId: z.string(),
    exitCode: z.number(),
  }),
  /** terminalId is null when terminal.open itself failed. */
  z.object({
    type: z.literal("terminal.error"),
    terminalId: z.string().nullable(),
    message: z.string(),
  }),
  /**
   * Response status + headers for a preview.fetch. Hop-by-hop and
   * framing-sensitive headers (content-length/-encoding) are already
   * stripped daemon-side, as are frame-blocking ones (CSP, x-frame-options)
   * — the whole point is rendering the page inside the app.
   */
  z.object({
    type: z.literal("preview.head"),
    requestId: previewId,
    status: z.number().int().min(100).max(599),
    headers: HeaderPairs,
  }),
  /** One base64 chunk of the response body, in order. */
  z.object({
    type: z.literal("preview.body"),
    requestId: previewId,
    chunk: z.string(),
  }),
  z.object({ type: z.literal("preview.end"), requestId: previewId }),
  /** The request failed (before or mid-body) — e.g. nothing listens there. */
  z.object({
    type: z.literal("preview.error"),
    requestId: previewId,
    message: z.string(),
  }),
  z.object({ type: z.literal("preview.ws.opened"), socketId: previewId }),
  /** One WebSocket message from the target server; data is base64. */
  z.object({
    type: z.literal("preview.ws.message"),
    socketId: previewId,
    data: z.string(),
    binary: z.boolean(),
  }),
  /** Sent for both clean closes and failed preview.ws.open attempts. */
  z.object({
    type: z.literal("preview.ws.closed"),
    socketId: previewId,
    code: z.number().int(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------------------------------------------------------------------------
// Envelope + codecs
// ---------------------------------------------------------------------------

const envelope = <T extends z.ZodTypeAny>(msg: T) =>
  z.object({ v: z.literal(PROTOCOL_VERSION), msg });

export const ClientEnvelope = envelope(ClientMessage);
export type ClientEnvelope = z.infer<typeof ClientEnvelope>;
export const ServerEnvelope = envelope(ServerMessage);
export type ServerEnvelope = z.infer<typeof ServerEnvelope>;

export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, msg });
}

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, msg });
}

function decode<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T>["msg"] | null {
  let raw: unknown = data;
  if (typeof data === "string") {
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data.msg : null;
}

/** Parse + validate an incoming client message. Returns null on any mismatch. */
export function decodeClient(data: unknown): ClientMessage | null {
  return decode(ClientEnvelope, data);
}

/** Parse + validate an incoming server message. Returns null on any mismatch. */
export function decodeServer(data: unknown): ServerMessage | null {
  return decode(ServerEnvelope, data);
}
