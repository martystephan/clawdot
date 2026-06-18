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
 * - `browser.*` drives a REAL headless Chromium running on the daemon's
 *   machine (one tab per session) and streams it to the app. The page
 *   genuinely executes server-side — its requests originate from the
 *   daemon's host, with the daemon's IP/DNS/cookies — so a previewed dev
 *   server (or any site) can't tell it's being viewed from a phone, and
 *   there is no CORS/SSRF/service-worker glue. The daemon screencasts the
 *   tab as `browser.frame` (base64 JPEG) and the client sends `browser.input`
 *   (mouse/wheel/keys) back; `browser.eval`/`browser.dom` expose the live DOM
 *   to the app. This replaced an earlier service-worker HTTP/WS proxy.
 * - further `surface.*` events (test panels, …) will be added later and
 *   must never require changes to the transport layer.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 18;

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

// --- Remote browser (browser.*) building blocks -------------------------

/** Identifies one headless-browser tab for the lifetime of a connection. */
const browserId = z.string().min(1).max(128);
/** Correlates a browser.eval/browser.dom request with its reply. */
const browserReqId = z.string().min(1).max(128);
const browserPort = z.number().int().min(1).max(65535);
/** Viewport / device-scale bounds for the emulated tab. */
const viewportDim = z.number().int().min(1).max(8192);
const devicePixelRatio = z.number().min(0.5).max(4);

/**
 * One input event for the remote tab, produced from a DOM pointer/keyboard
 * event on the client and dispatched verbatim via CDP. Coordinates are CSS
 * pixels in the tab's viewport (the client maps them from the rendered frame).
 */
export const BrowserInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "middle", "right"]),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: z.number(),
    y: z.number(),
    deltaX: z.number(),
    deltaY: z.number(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({
    kind: z.literal("key"),
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().max(64).optional(),
    code: z.string().max(64).optional(),
    text: z.string().max(8).optional(),
    windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  // Paste: insert a whole string into the focused element at once (CDP
  // Input.insertText), instead of replaying it as individual keystrokes.
  z.object({
    kind: z.literal("text"),
    text: z.string().max(100_000),
  }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;

/** Screencast frame geometry, forwarded from CDP so the client can map input. */
export const BrowserFrameMeta = z.object({
  /** Page width/height in CSS pixels (the emulated viewport). */
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  pageScaleFactor: z.number(),
  offsetTop: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
});
export type BrowserFrameMeta = z.infer<typeof BrowserFrameMeta>;

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
    /** Push a notification when an agent rings the bell while unwatched. Omitted = keep. */
    notifyOnBell: z.boolean().optional(),
  }),
  /**
   * Open a headless-browser tab on the daemon's machine and start streaming
   * it. Navigates to loopback `http://localhost:<port>/` (a dev server on the
   * daemon's host) unless an absolute `url` is given. Replies browser.opened,
   * then a stream of browser.frame; browser.closed on failure. The tab is
   * owned by this connection and closes with it.
   */
  z.object({
    type: z.literal("browser.open"),
    sessionId: browserId,
    port: browserPort.optional(),
    url: z.string().url().max(8192).optional(),
    width: viewportDim,
    height: viewportDim,
    dpr: devicePixelRatio,
  }),
  /** Navigate an open tab (address bar). */
  z.object({
    type: z.literal("browser.navigate"),
    sessionId: browserId,
    url: z.string().url().max(8192),
  }),
  /** Browser-chrome navigation: history back/forward and reload. */
  z.object({
    type: z.literal("browser.action"),
    sessionId: browserId,
    action: z.enum(["back", "forward", "reload"]),
  }),
  /** One input event (mouse/wheel/key) for the tab. */
  z.object({
    type: z.literal("browser.input"),
    sessionId: browserId,
    event: BrowserInput,
  }),
  /** Resize the emulated viewport (panel resize / device rotation). */
  z.object({
    type: z.literal("browser.resize"),
    sessionId: browserId,
    width: viewportDim,
    height: viewportDim,
    dpr: devicePixelRatio,
  }),
  /**
   * Pause/resume frame delivery without closing the tab. A backgrounded view
   * (the user switched to another session) sets active:false so the daemon
   * keeps the page running but stops streaming frames over the link; resuming
   * pushes the current frame immediately so the view repaints at once.
   */
  z.object({
    type: z.literal("browser.setActive"),
    sessionId: browserId,
    active: z.boolean(),
  }),
  /**
   * Evaluate a JS expression in the tab's page context and reply with
   * browser.eval.result. This is the DOM-access path: the app can query or
   * mutate the live (server-side) DOM. Result must be JSON-serializable.
   */
  z.object({
    type: z.literal("browser.eval"),
    sessionId: browserId,
    requestId: browserReqId,
    expression: z.string().min(1).max(1_000_000),
  }),
  /** Snapshot the tab's serialized DOM; replies browser.dom. */
  z.object({
    type: z.literal("browser.dom"),
    sessionId: browserId,
    requestId: browserReqId,
  }),
  /** Close the tab (panel closed / port changed). */
  z.object({ type: z.literal("browser.close"), sessionId: browserId }),
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
   * Ask the daemon for the health of its outbound relay link (connected,
   * last error, reconnect attempts). Local socket only, like pair.start —
   * it's a diagnostic for the CLI, not something remote clients need.
   */
  z.object({ type: z.literal("relay.status") }),
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
   * the ticket in the fragment; `expiresAt` is a unix ms deadline, or null when
   * unlimited pairing is on (the token never expires and pairs many devices).
   */
  z.object({
    type: z.literal("pair.ticket"),
    ticket: z.string(),
    url: z.string(),
    relayUrl: z.string(),
    expiresAt: z.number().nullable(),
  }),
  /** Response to device.list / device.revoke. */
  z.object({
    type: z.literal("device.list"),
    devices: z.array(DeviceMeta),
  }),
  /**
   * Response to relay.status — the daemon's outbound relay link health.
   * `configured` is false when no relay is set (remote access off). Times are
   * unix ms; `attempts` counts consecutive failed reconnects since the last
   * successful connect (0 while connected).
   */
  z.object({
    type: z.literal("relay.status"),
    configured: z.boolean(),
    relayUrl: z.string().nullable(),
    connected: z.boolean(),
    lastError: z.string().nullable(),
    lastErrorAt: z.number().nullable(),
    lastConnectedAt: z.number().nullable(),
    attempts: z.number(),
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
  /** The tab opened and is now streaming. */
  z.object({
    type: z.literal("browser.opened"),
    sessionId: browserId,
    url: z.string(),
    title: z.string(),
  }),
  /** One screencast frame: base64 JPEG plus the geometry to map input. */
  z.object({
    type: z.literal("browser.frame"),
    sessionId: browserId,
    data: z.string(),
    meta: BrowserFrameMeta,
  }),
  /** The tab navigated (link click, pushState, redirect) — update the address. */
  z.object({
    type: z.literal("browser.navigated"),
    sessionId: browserId,
    url: z.string(),
    title: z.string(),
    /** Whether the tab's history allows going back/forward (for the chrome). */
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
  }),
  /** Reply to browser.eval. `ok` false carries the thrown error in `error`. */
  z.object({
    type: z.literal("browser.eval.result"),
    sessionId: browserId,
    requestId: browserReqId,
    ok: z.boolean(),
    /** JSON-encoded result value when ok; absent otherwise. */
    value: z.string().optional(),
    error: z.string().optional(),
  }),
  /** Reply to browser.dom: the tab's serialized document. */
  z.object({
    type: z.literal("browser.dom"),
    sessionId: browserId,
    requestId: browserReqId,
    html: z.string(),
  }),
  /** The tab closed (requested, crashed, or failed to open). */
  z.object({
    type: z.literal("browser.closed"),
    sessionId: browserId,
    message: z.string().optional(),
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
