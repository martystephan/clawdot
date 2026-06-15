/**
 * @clawdot/protocol/tunnel
 *
 * End-to-end encryption + relay wire format for remote connections.
 *
 * Threat model: the relay (a VPS) is untrusted — it may read, replay, reorder
 * or inject frames, but it must never learn plaintext or be able to
 * impersonate either side. Security comes from an X25519 handshake
 * authenticated by the daemon's static key (pinned from the pairing ticket)
 * and either a one-time pairing secret (first contact) or the device's static
 * key (every reconnect after that).
 *
 * Handshake (Noise-IK-shaped, with a PSK mixed in when pairing):
 *
 *   client → daemon   hello:  0x01 || CE || AEAD(k1, n=0, mode || CS || [auth])
 *       k1   = HKDF(ECDH(ce, DS), salt=CE, info="clawdot/v1/hello")
 *       auth = HMAC(secret, CE || CS || DS)            (pairing mode only)
 *   daemon → client   reply:  0x02 || DE || AEAD(keyS2C, n=0, "clawdot-ok")
 *
 *   transcript = SHA256(hello || DE)
 *   master     = HKDF(ECDH(ce,DE) || ECDH(ce,DS) || ECDH(cs,DE) || [secret],
 *                     salt=transcript, info="clawdot/v1/master", 64 bytes)
 *   keyC2S, keyS2C = master[0..32], master[32..64]
 *
 * (D=daemon, C=client; S=static, E=ephemeral. ECDH(ce,DS) authenticates the
 * daemon, ECDH(cs,DE) the device, the secret a first-time pairing; ECDH(ce,DE)
 * gives forward secrecy. The client's identity travels only inside ciphertext
 * the relay cannot open.)
 *
 * After the handshake every frame is ChaCha20-Poly1305 with implicit
 * counter nonces and separate per-direction keys. The relay rides on
 * TCP-ordered WebSockets, so a lost/reordered/forged frame is a decrypt
 * failure and the connection is torn down — never silently skipped.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Byte helpers (isomorphic: browser + Node >= 20, no Buffer)
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  try {
    const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * noble v2 requires Uint8Array<ArrayBuffer>; our public API accepts plain
 * Uint8Array (callers hand us ws Buffers and slices). Runtime-identical.
 */
const ab = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>;

/** Constant-time byte comparison — never branch on secret-derived data. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const KEY_LENGTH = 32;
export const SECRET_LENGTH = 32;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(ab(secretKey)) };
}

/**
 * Relay routing id for a daemon. Derived (one-way) from the static public key
 * so the relay never needs to be told the key itself.
 */
export function roomIdFor(daemonKey: Uint8Array): string {
  return toHex(sha256(concatBytes(utf8("clawdot/v1/room"), daemonKey)).slice(0, 16));
}

// ---------------------------------------------------------------------------
// Pairing ticket — what the QR code / pairing code carries
// ---------------------------------------------------------------------------

export interface PairingTicket {
  /** wss:// (or ws:// for local dev) endpoint of the relay. */
  relayUrl: string;
  /** Daemon static public key — the client pins this. */
  daemonKey: Uint8Array;
  /** One-time pairing secret proving the scanner saw the QR. */
  secret: Uint8Array;
}

export function encodeTicket(ticket: PairingTicket): string {
  return toBase64Url(
    utf8(
      JSON.stringify({
        v: 1,
        u: ticket.relayUrl,
        k: toBase64Url(ticket.daemonKey),
        s: toBase64Url(ticket.secret),
      }),
    ),
  );
}

export function decodeTicket(text: string): PairingTicket | null {
  const raw = fromBase64Url(text.trim());
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  const shape = z
    .object({ v: z.literal(1), u: z.string().regex(/^wss?:\/\//), k: z.string(), s: z.string() })
    .safeParse(parsed);
  if (!shape.success) return null;
  const daemonKey = fromBase64Url(shape.data.k);
  const secret = fromBase64Url(shape.data.s);
  if (daemonKey?.length !== KEY_LENGTH || secret?.length !== SECRET_LENGTH) return null;
  return { relayUrl: shape.data.u, daemonKey, secret };
}

/**
 * The URL a pairing QR encodes: the web app hosted next to the relay, with
 * the ticket in the fragment — fragments never reach the server in a request.
 */
export function pairingUrl(ticket: PairingTicket): string {
  const relay = new URL(ticket.relayUrl);
  const proto = relay.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${relay.host}/#pair=${encodeTicket(ticket)}`;
}

// ---------------------------------------------------------------------------
// Secure channel — per-direction keys, implicit counter nonces
// ---------------------------------------------------------------------------

const NONCE_LENGTH = 12;
const ZERO_NONCE = new Uint8Array(NONCE_LENGTH);

export class SecureChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly recvKey: Uint8Array,
  ) {}

  private static nonce(counter: bigint): Uint8Array {
    const nonce = new Uint8Array(NONCE_LENGTH);
    new DataView(nonce.buffer).setBigUint64(4, counter);
    return nonce;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    const nonce = SecureChannel.nonce(this.sendCounter++);
    return chacha20poly1305(this.sendKey, nonce).encrypt(plaintext);
  }

  sealText(text: string): Uint8Array {
    return this.seal(utf8(text));
  }

  /** Returns null on tamper/reorder — callers must tear the connection down. */
  open(frame: Uint8Array): Uint8Array | null {
    const nonce = SecureChannel.nonce(this.recvCounter);
    try {
      const plaintext = chacha20poly1305(this.recvKey, nonce).decrypt(frame);
      this.recvCounter++;
      return plaintext;
    } catch {
      return null;
    }
  }

  openText(frame: Uint8Array): string | null {
    const plaintext = this.open(frame);
    return plaintext === null ? null : decoder.decode(plaintext);
  }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

const HELLO_TAG = 0x01;
const REPLY_TAG = 0x02;
const MODE_DEVICE = 0x00;
const MODE_PAIR = 0x01;
const AEAD_TAG_LENGTH = 16;
const CONFIRM = utf8("clawdot-ok");

function deriveHelloKey(shared: Uint8Array, clientEphemeral: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, clientEphemeral, utf8("clawdot/v1/hello"), KEY_LENGTH);
}

function deriveDirectionKeys(
  ikm: Uint8Array,
  transcript: Uint8Array,
): { c2s: Uint8Array; s2c: Uint8Array } {
  const okm = hkdf(sha256, ikm, transcript, utf8("clawdot/v1/master"), 64);
  return { c2s: okm.slice(0, 32), s2c: okm.slice(32) };
}

export interface ClientHandshake {
  /** First frame to send over the freshly opened channel. */
  hello: Uint8Array;
  /** Process the daemon's reply. Null means authentication failed. */
  finish(reply: Uint8Array): SecureChannel | null;
}

export function startClientHandshake(opts: {
  daemonKey: Uint8Array;
  deviceKeyPair: KeyPair;
  /** Present on first contact only; afterwards the device key authenticates. */
  pairingSecret?: Uint8Array;
}): ClientHandshake {
  const eph = generateKeyPair();
  const helloKey = deriveHelloKey(
    x25519.getSharedSecret(ab(eph.secretKey), ab(opts.daemonKey)),
    eph.publicKey,
  );
  const mode = opts.pairingSecret ? MODE_PAIR : MODE_DEVICE;
  const payload = [new Uint8Array([mode]), opts.deviceKeyPair.publicKey];
  if (opts.pairingSecret) {
    payload.push(
      hmac(
        sha256,
        opts.pairingSecret,
        concatBytes(eph.publicKey, opts.deviceKeyPair.publicKey, opts.daemonKey),
      ),
    );
  }
  const ciphertext = chacha20poly1305(helloKey, ZERO_NONCE).encrypt(concatBytes(...payload));
  const hello = concatBytes(new Uint8Array([HELLO_TAG]), eph.publicKey, ciphertext);

  return {
    hello,
    finish(reply) {
      if (reply.length < 1 + KEY_LENGTH + AEAD_TAG_LENGTH || reply[0] !== REPLY_TAG) return null;
      const daemonEphemeral = reply.slice(1, 1 + KEY_LENGTH);
      const confirmCiphertext = reply.slice(1 + KEY_LENGTH);
      const transcript = sha256(concatBytes(hello, daemonEphemeral));
      const ikm = [
        x25519.getSharedSecret(eph.secretKey, ab(daemonEphemeral)),
        x25519.getSharedSecret(eph.secretKey, ab(opts.daemonKey)),
        x25519.getSharedSecret(ab(opts.deviceKeyPair.secretKey), ab(daemonEphemeral)),
      ];
      if (opts.pairingSecret) ikm.push(ab(opts.pairingSecret));
      const { c2s, s2c } = deriveDirectionKeys(concatBytes(...ikm), transcript);
      const channel = new SecureChannel(c2s, s2c);
      const confirm = channel.open(confirmCiphertext);
      if (!confirm || !bytesEqual(confirm, CONFIRM)) return null;
      return channel;
    },
  };
}

export interface HandshakeResult {
  /** Reply frame to send back to the client. */
  reply: Uint8Array;
  channel: SecureChannel;
  devicePublicKey: Uint8Array;
  /** True when a pairing secret was used — register the device on success. */
  paired: boolean;
}

/** Daemon side of the handshake. Null means reject — close the channel. */
export function respondToHello(
  hello: Uint8Array,
  opts: {
    daemonKeyPair: KeyPair;
    isTrustedDevice: (devicePublicKey: Uint8Array) => boolean;
    /** Currently valid pairing secret, or null when not in pairing mode. */
    pairingSecret: () => Uint8Array | null;
  },
): HandshakeResult | null {
  if (hello.length < 1 + KEY_LENGTH + AEAD_TAG_LENGTH || hello[0] !== HELLO_TAG) return null;
  const clientEphemeral = hello.slice(1, 1 + KEY_LENGTH);
  const helloKey = deriveHelloKey(
    x25519.getSharedSecret(ab(opts.daemonKeyPair.secretKey), ab(clientEphemeral)),
    clientEphemeral,
  );
  let payload: Uint8Array;
  try {
    payload = chacha20poly1305(helloKey, ZERO_NONCE).decrypt(hello.slice(1 + KEY_LENGTH));
  } catch {
    return null;
  }
  const mode = payload[0];
  const devicePublicKey = payload.slice(1, 1 + KEY_LENGTH);
  if (devicePublicKey.length !== KEY_LENGTH) return null;

  let secretUsed: Uint8Array | null = null;
  if (mode === MODE_PAIR) {
    const secret = opts.pairingSecret();
    if (!secret || payload.length !== 1 + KEY_LENGTH + 32) return null;
    const expected = hmac(
      sha256,
      secret,
      concatBytes(clientEphemeral, devicePublicKey, opts.daemonKeyPair.publicKey),
    );
    if (!bytesEqual(payload.slice(1 + KEY_LENGTH), expected)) return null;
    secretUsed = secret;
  } else if (mode === MODE_DEVICE) {
    if (payload.length !== 1 + KEY_LENGTH) return null;
    if (!opts.isTrustedDevice(devicePublicKey)) return null;
  } else {
    return null;
  }

  const eph = generateKeyPair();
  const transcript = sha256(concatBytes(hello, eph.publicKey));
  const ikm = [
    x25519.getSharedSecret(eph.secretKey, ab(clientEphemeral)),
    x25519.getSharedSecret(ab(opts.daemonKeyPair.secretKey), ab(clientEphemeral)),
    x25519.getSharedSecret(eph.secretKey, ab(devicePublicKey)),
  ];
  if (secretUsed) ikm.push(ab(secretUsed));
  const { c2s, s2c } = deriveDirectionKeys(concatBytes(...ikm), transcript);
  const channel = new SecureChannel(s2c, c2s);
  const reply = concatBytes(new Uint8Array([REPLY_TAG]), eph.publicKey, channel.seal(CONFIRM));
  return { reply, channel, devicePublicKey, paired: mode === MODE_PAIR };
}

// ---------------------------------------------------------------------------
// Relay wire format — the only vocabulary the relay understands.
// Everything inside data frames is ciphertext the relay cannot open.
// ---------------------------------------------------------------------------

export const RELAY_PATH = "/v1";

/** First (text) message a connector sends after the socket opens. */
export const RelayHello = z.object({
  role: z.enum(["daemon", "client"]),
  room: z.string().min(8).max(128),
});
export type RelayHello = z.infer<typeof RelayHello>;

/** Relay → daemon control messages (text frames). */
export const RelayDaemonControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel.open"), ch: z.number().int().nonnegative() }),
  z.object({ type: z.literal("channel.close"), ch: z.number().int().nonnegative() }),
  /**
   * Tokens FCM rejected as permanently invalid (the device uninstalled or its
   * registration rotated). The relay stores nothing, so it reports them back
   * and the daemon — the sole owner of the token registry — prunes them.
   */
  z.object({ type: z.literal("push.dead"), tokens: z.array(z.string().max(4096)).max(256) }),
]);
export type RelayDaemonControl = z.infer<typeof RelayDaemonControl>;

/**
 * Daemon → relay control messages (text frames). The only thing the daemon
 * ever asks the relay to do besides forward ciphertext: emit a push.
 *
 * This is the one deliberate exception to "the relay only sees ciphertext".
 * The daemon (which alone holds plaintext) decides WHEN to notify and to WHICH
 * device tokens; the relay just hands the token + a deliberately generic
 * payload to FCM and forgets both. It persists nothing — keep it that way.
 */
export const DaemonRelayControl = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("push.send"),
    /** FCM registration tokens of the devices to notify. */
    tokens: z.array(z.string().min(1).max(4096)).min(1).max(256),
    /** Kept generic on purpose — the relay must not learn task content. */
    title: z.string().min(1).max(256),
    body: z.string().max(1024),
  }),
]);
export type DaemonRelayControl = z.infer<typeof DaemonRelayControl>;

/** Relay → client control messages (text frames). */
export const RelayClientControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("close"), reason: z.string() }),
]);
export type RelayClientControl = z.infer<typeof RelayClientControl>;

function decodeJson<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> | null {
  let raw: unknown = data;
  if (typeof data === "string") {
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const decodeRelayHello = (data: unknown): RelayHello | null =>
  decodeJson(RelayHello, data);
export const decodeRelayDaemonControl = (data: unknown): RelayDaemonControl | null =>
  decodeJson(RelayDaemonControl, data);
export const decodeRelayClientControl = (data: unknown): RelayClientControl | null =>
  decodeJson(RelayClientControl, data);
export const decodeDaemonRelayControl = (data: unknown): DaemonRelayControl | null =>
  decodeJson(DaemonRelayControl, data);

/**
 * Binary frames on the daemon's relay socket are channel-multiplexed:
 * 4-byte big-endian channel id, then the (encrypted) payload. Client sockets
 * carry bare payloads — the relay adds/strips the prefix.
 */
export function packChannelFrame(ch: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, ch);
  out.set(payload, 4);
  return out;
}

export function unpackChannelFrame(
  frame: Uint8Array,
): { ch: number; payload: Uint8Array } | null {
  if (frame.length < 4) return null;
  const ch = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0);
  return { ch, payload: frame.slice(4) };
}
