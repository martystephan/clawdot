/**
 * Daemon side of the remote tunnel: a persistent identity, the trusted-device
 * registry, the pairing window, and the outbound relay connection.
 *
 * The daemon dials OUT to the relay (no port forwarding ever needed) and
 * keeps one socket; each remote client is a multiplexed channel on it. Every
 * channel runs its own E2E handshake — the relay only ever sees ciphertext.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import {
  SECRET_LENGTH,
  encodeTicket,
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  packChannelFrame,
  pairingUrl,
  randomBytes,
  respondToHello,
  roomIdFor,
  toBase64Url,
  unpackChannelFrame,
  decodeRelayDaemonControl,
  type DaemonRelayControl,
  type KeyPair,
  type SecureChannel,
} from "@clawdot/protocol/tunnel";

const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/**
 * How often to send a WebSocket ping to the relay. After sleep the OS silently
 * drops the TCP connection; without a heartbeat the close event never fires and
 * the relay link stays a zombie forever. 30 s keeps latency to one interval
 * post-wake without generating noticeable traffic.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

interface DeviceRecord {
  addedAt: number;
  lastSeenAt: number;
  /**
   * Push registration for this device, set via notify.register over its own
   * E2E channel. Stored here because it is device-scoped trust state, exactly
   * like the rest of this registry. Absent until the device opts in.
   */
  push?: { token: string; platform: string; updatedAt: number };
}

/** A device to push to: the token plus the platform that minted it. */
export interface PushTarget {
  token: string;
  platform: string;
}

/**
 * Identity + trust state, persisted in the data dir. Losing identity.json
 * unpairs every device (the QR pins the public key), so it is never
 * regenerated over an existing unreadable file.
 */
export class TunnelService {
  readonly identity: KeyPair;
  readonly roomId: string;
  private readonly devicesPath: string;
  private devices: Record<string, DeviceRecord> = {};
  // Devices whose app is currently in the foreground (in-memory, ephemeral
  // connection state — never persisted). Excluded from pushTargets: a user
  // looking at the app shouldn't be pushed about a background terminal.
  private readonly foregroundDevices = new Set<string>();
  /**
   * The open pairing window. `expiresAt: null` means it never expires and
   * `persistent: true` means a successful pairing does NOT consume it (the
   * unlimited mode used for reviewer test links). Ordinary windows are
   * time-limited and single-use.
   */
  private window: {
    secret: Uint8Array;
    expiresAt: number | null;
    persistent: boolean;
  } | null = null;
  /** Where the unlimited-pairing secret persists, so its token survives restarts. */
  private readonly pairingPath: string;

  constructor(
    dataDir: string,
    readonly relayUrl: string,
  ) {
    this.pairingPath = join(dataDir, "pairing.json");
    const identityPath = join(dataDir, "identity.json");
    if (existsSync(identityPath)) {
      const raw = JSON.parse(readFileSync(identityPath, "utf8")) as {
        secretKey?: string;
      };
      const secretKey = raw.secretKey ? fromBase64Url(raw.secretKey) : null;
      if (!secretKey) {
        throw new Error(
          `corrupt ${identityPath} — delete it to generate a new identity (this unpairs all devices)`,
        );
      }
      this.identity = keyPairFromSecret(secretKey);
    } else {
      this.identity = generateKeyPair();
      writeFileSync(
        identityPath,
        JSON.stringify({ secretKey: toBase64Url(this.identity.secretKey) }, null, 2),
      );
      chmodSync(identityPath, 0o600);
    }
    this.roomId = roomIdFor(this.identity.publicKey);

    this.devicesPath = join(dataDir, "devices.json");
    if (existsSync(this.devicesPath)) {
      try {
        this.devices = JSON.parse(readFileSync(this.devicesPath, "utf8"));
      } catch {
        this.devices = {};
      }
    }
  }

  private saveDevices(): void {
    writeFileSync(this.devicesPath, JSON.stringify(this.devices, null, 2));
  }

  /**
   * Reconcile the persistent (unlimited) pairing window with the config flag,
   * called once at startup. When on, opens a never-expiring window from a
   * secret persisted in the data dir, so the same token keeps working across
   * daemon restarts and pairs any number of devices. When off, forgets any
   * persisted unlimited token so disabling the setting actually revokes it.
   */
  setUnlimitedPairing(enabled: boolean): void {
    if (enabled) {
      this.window = { secret: this.loadOrCreatePairingSecret(), expiresAt: null, persistent: true };
    } else {
      if (existsSync(this.pairingPath)) rmSync(this.pairingPath);
      if (this.window?.persistent) this.window = null;
    }
  }

  private loadOrCreatePairingSecret(): Uint8Array {
    if (existsSync(this.pairingPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.pairingPath, "utf8")) as { secret?: string };
        const decoded = raw.secret ? fromBase64Url(raw.secret) : null;
        if (decoded) return decoded;
      } catch {
        // Corrupt — fall through and mint a fresh one.
      }
    }
    const secret = randomBytes(SECRET_LENGTH);
    writeFileSync(this.pairingPath, JSON.stringify({ secret: toBase64Url(secret) }, null, 2));
    chmodSync(this.pairingPath, 0o600);
    return secret;
  }

  /**
   * Open a pairing window. By default: one secret, one device, limited time.
   * With `unlimited`, reuses the persisted never-expiring secret so the token
   * is stable across restarts and pairs unlimited devices.
   */
  startPairing(opts: { unlimited?: boolean } = {}): {
    ticket: string;
    url: string;
    expiresAt: number | null;
  } {
    let secret: Uint8Array;
    let expiresAt: number | null;
    if (opts.unlimited) {
      // Reuse the already-open persistent window's secret if present, so a
      // re-run of `clawdot pair` reprints the same token.
      const open = this.window;
      secret = open?.persistent ? open.secret : this.loadOrCreatePairingSecret();
      expiresAt = null;
    } else {
      secret = randomBytes(SECRET_LENGTH);
      expiresAt = Date.now() + PAIRING_WINDOW_MS;
    }
    this.window = { secret, expiresAt, persistent: opts.unlimited ?? false };
    const ticket = {
      relayUrl: this.relayUrl,
      daemonKey: this.identity.publicKey,
      secret,
    };
    return { ticket: encodeTicket(ticket), url: pairingUrl(ticket), expiresAt };
  }

  pairingSecret(): Uint8Array | null {
    if (!this.window) return null;
    if (this.window.expiresAt !== null && Date.now() > this.window.expiresAt) return null;
    return this.window.secret;
  }

  isTrusted(devicePublicKey: Uint8Array): boolean {
    return toBase64Url(devicePublicKey) in this.devices;
  }

  /**
   * Called after a successful pairing handshake. Consumes an ordinary window;
   * a persistent (unlimited) window stays open so more devices can pair.
   */
  registerDevice(devicePublicKey: Uint8Array): void {
    const key = toBase64Url(devicePublicKey);
    this.devices[key] = {
      addedAt: this.devices[key]?.addedAt ?? Date.now(),
      lastSeenAt: Date.now(),
    };
    if (!this.window?.persistent) this.window = null;
    this.saveDevices();
  }

  touchDevice(devicePublicKey: Uint8Array): void {
    const record = this.devices[toBase64Url(devicePublicKey)];
    if (record) {
      record.lastSeenAt = Date.now();
      this.saveDevices();
    }
  }

  /**
   * Record (or refresh) a device's push token. No-op for an unknown device —
   * only a paired, trusted device can register, and the key comes straight
   * from its authenticated channel.
   */
  setPushToken(deviceKey: string, token: string, platform: string): void {
    const record = this.devices[deviceKey];
    if (!record) return;
    record.push = { token, platform, updatedAt: Date.now() };
    this.saveDevices();
  }

  /** Forget a device's push token (it turned notifications off). */
  clearPushToken(deviceKey: string): void {
    const record = this.devices[deviceKey];
    if (record?.push) {
      delete record.push;
      this.saveDevices();
    }
  }

  /**
   * Mark whether a device's app is foregrounded. Foreground devices are
   * dropped from pushTargets so the user isn't pushed while looking at the
   * app. Cleared on disconnect (a vanished client isn't foreground).
   */
  setForeground(deviceKey: string, foreground: boolean): void {
    if (foreground) this.foregroundDevices.add(deviceKey);
    else this.foregroundDevices.delete(deviceKey);
  }

  /**
   * Registered push targets across all trusted devices, excluding any whose
   * app is currently foregrounded (they'd see the attention in-app).
   */
  pushTargets(): PushTarget[] {
    return Object.entries(this.devices)
      .filter(([key]) => !this.foregroundDevices.has(key))
      .map(([, record]) => record.push)
      .filter((push): push is NonNullable<typeof push> => !!push)
      .map(({ token, platform }) => ({ token, platform }));
  }

  /**
   * Drop tokens FCM reported as permanently dead (uninstalled / rotated), as
   * relayed back from the relay after a push. Keeps the registry from
   * accumulating tokens that will never deliver again.
   */
  prunePushTokens(tokens: string[]): void {
    const dead = new Set(tokens);
    let changed = false;
    for (const record of Object.values(this.devices)) {
      if (record.push && dead.has(record.push.token)) {
        delete record.push;
        changed = true;
      }
    }
    if (changed) this.saveDevices();
  }

  listDevices(): Array<{ key: string; addedAt: number; lastSeenAt: number }> {
    return Object.entries(this.devices)
      .map(([key, record]) => ({ key, ...record }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Stop trusting a device. Future handshakes fail immediately; a connection
   * that is already open lives until it drops (channels hold no identity
   * re-check — acceptable because revocation is a local, deliberate act).
   */
  revokeDevice(key: string): void {
    delete this.devices[key];
    this.saveDevices();
  }
}

export interface ChannelHandler {
  handleMessage(text: string): void;
  handleClose(): void;
}

interface ChannelState {
  secure: SecureChannel | null;
  handler: ChannelHandler | null;
  /** Failed handshake or decrypt — ignore everything else on this channel. */
  dead: boolean;
}

/** Normalize a ws RawData value to a single Uint8Array. */
function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

/**
 * The daemon's persistent connection to the relay. Reconnects with backoff;
 * a relay outage drops remote clients (they reconnect and reattach their
 * terminals, same as any other disconnect) but never touches daemon state.
 */
export class RelayLink {
  private ws: WebSocket | null = null;
  private channels = new Map<number, ChannelState>();
  private backoffMs = RECONNECT_MIN_MS;
  private stopped = false;

  constructor(
    private readonly opts: {
      tunnel: TunnelService;
      /**
       * Bind a freshly authenticated remote client into the daemon. `deviceKey`
       * is the channel's authenticated device (base64url public key) — used to
       * associate a notify.register token with the right device.
       */
      attach: (send: (text: string) => void, deviceKey: string) => ChannelHandler;
      /** FCM reported these tokens permanently dead — prune them. */
      onPushDead?: (tokens: string[]) => void;
    },
  ) {}

  /**
   * Ask the relay to emit a push (the one daemon → relay request). Sent as a
   * plaintext control frame — it carries only device tokens and a generic
   * payload, never E2E ciphertext or task content.
   */
  sendControl(msg: DaemonRelayControl): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    const { tunnel } = this.opts;
    const ws = new WebSocket(tunnel.relayUrl);
    this.ws = ws;

    // Heartbeat: after sleep the OS silently drops the TCP connection without
    // generating a close event. Periodic pings detect the dead socket and
    // trigger onDisconnect → reconnect within one interval of waking up.
    let alive = false;
    let heartbeat: NodeJS.Timeout | null = null;

    ws.on("open", () => {
      this.backoffMs = RECONNECT_MIN_MS;
      alive = true;
      heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate(); // triggers close → onDisconnect → reconnect
          return;
        }
        alive = false;
        ws.ping();
      }, HEARTBEAT_INTERVAL_MS);
      ws.send(JSON.stringify({ role: "daemon", room: tunnel.roomId }));
      console.log(`relay: connected to ${tunnel.relayUrl} (room ${tunnel.roomId})`);
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) this.onFrame(asBytes(data));
      else this.onControl(String(data));
    });
    ws.on("error", (err) => {
      if (this.backoffMs === RECONNECT_MIN_MS) {
        // connection-refused AggregateErrors carry an empty message
        const reason =
          err.message || (err as NodeJS.ErrnoException).code || "connection failed";
        console.warn(`relay: ${reason} — retrying`);
      }
    });
    ws.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      this.onDisconnect();
    });
  }

  private onControl(text: string): void {
    const msg = decodeRelayDaemonControl(text);
    if (!msg) return;
    if (msg.type === "channel.open") {
      this.channels.set(msg.ch, { secure: null, handler: null, dead: false });
    } else if (msg.type === "channel.close") {
      const state = this.channels.get(msg.ch);
      state?.handler?.handleClose();
      this.channels.delete(msg.ch);
    } else {
      // push.dead — tokens FCM rejected; prune them from the registry.
      this.opts.onPushDead?.(msg.tokens);
    }
  }

  private onFrame(frame: Uint8Array): void {
    const unpacked = unpackChannelFrame(frame);
    if (!unpacked) return;
    const state = this.channels.get(unpacked.ch);
    if (!state || state.dead) return;

    if (!state.secure) {
      const { tunnel } = this.opts;
      const result = respondToHello(unpacked.payload, {
        daemonKeyPair: tunnel.identity,
        isTrustedDevice: (pub) => tunnel.isTrusted(pub),
        pairingSecret: () => tunnel.pairingSecret(),
      });
      if (!result) {
        state.dead = true; // unauthenticated peer learns nothing, not even why
        return;
      }
      if (result.paired) tunnel.registerDevice(result.devicePublicKey);
      else tunnel.touchDevice(result.devicePublicKey);
      state.secure = result.channel;
      this.send(unpacked.ch, result.reply);
      const deviceKey = toBase64Url(result.devicePublicKey);
      state.handler = this.opts.attach((text) => {
        if (state.secure && !state.dead) this.send(unpacked.ch, state.secure.sealText(text));
      }, deviceKey);
      return;
    }

    const text = state.secure.openText(unpacked.payload);
    if (text === null) {
      state.dead = true;
      state.handler?.handleClose();
      state.handler = null;
      return;
    }
    state.handler?.handleMessage(text);
  }

  private send(ch: number, payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(packChannelFrame(ch, payload));
    }
  }

  private onDisconnect(): void {
    for (const state of this.channels.values()) state.handler?.handleClose();
    this.channels.clear();
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }
}
