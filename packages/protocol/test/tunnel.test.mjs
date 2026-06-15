// Unit tests for the E2E tunnel crypto. Runs against src/ via tsx — no build:
// pnpm --filter @clawdot/protocol test
import test from "node:test";
import assert from "node:assert/strict";
import {
  SecureChannel,
  decodeTicket,
  encodeTicket,
  fromBase64Url,
  generateKeyPair,
  packChannelFrame,
  pairingUrl,
  randomBytes,
  respondToHello,
  roomIdFor,
  startClientHandshake,
  toBase64Url,
  unpackChannelFrame,
} from "../src/tunnel.ts";

const utf8 = (s) => new TextEncoder().encode(s);

/** Run a full handshake and return both channels, or null when rejected. */
function handshake({ pairing = false, trusted = [], secret = null, clientSecret } = {}) {
  const daemon = generateKeyPair();
  const device = generateKeyPair();
  const client = startClientHandshake({
    daemonKey: daemon.publicKey,
    deviceKeyPair: device,
    pairingSecret: pairing ? (clientSecret ?? secret) : undefined,
  });
  const result = respondToHello(client.hello, {
    daemonKeyPair: daemon,
    isTrustedDevice: (pub) => trusted.some((t) => toBase64Url(t) === toBase64Url(pub)),
    pairingSecret: () => secret,
  });
  if (!result) return { result: null, client: null };
  return { result, client: client.finish(result.reply), device, daemon };
}

test("base64url round-trips arbitrary bytes", () => {
  const bytes = randomBytes(57);
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  assert.equal(fromBase64Url("!!!not base64!!!"), null);
});

test("pairing ticket round-trips and rejects garbage", () => {
  const ticket = {
    relayUrl: "wss://clawdot.testf.de/v1",
    daemonKey: randomBytes(32),
    secret: randomBytes(32),
  };
  const decoded = decodeTicket(encodeTicket(ticket));
  assert.equal(decoded.relayUrl, ticket.relayUrl);
  assert.deepEqual(decoded.daemonKey, ticket.daemonKey);
  assert.deepEqual(decoded.secret, ticket.secret);

  assert.equal(decodeTicket("garbage"), null);
  assert.equal(decodeTicket(toBase64Url(utf8('{"v":1,"u":"https://x","k":"a","s":"b"}'))), null);
  // QR URL points at the web app origin (relay path stripped), ticket in fragment
  assert.equal(
    pairingUrl(ticket),
    `https://clawdot.testf.de/#pair=${encodeTicket(ticket)}`,
  );
});

test("room id is deterministic and one-way-ish", () => {
  const key = randomBytes(32);
  assert.equal(roomIdFor(key), roomIdFor(key));
  assert.equal(roomIdFor(key).length, 32);
  assert.notEqual(roomIdFor(key), roomIdFor(randomBytes(32)));
});

test("pairing handshake establishes a working duplex channel", () => {
  const secret = randomBytes(32);
  const { result, client } = handshake({ pairing: true, secret });
  assert.ok(result, "daemon accepted the hello");
  assert.ok(client, "client accepted the reply");
  assert.equal(result.paired, true);

  // client → daemon
  const c2s = client.sealText("hello daemon");
  assert.equal(result.channel.openText(c2s), "hello daemon");
  // daemon → client
  const s2c = result.channel.sealText("hello device");
  assert.equal(client.openText(s2c), "hello device");
  // counters advance — same plaintext, different ciphertext, still decrypts
  const c2s2 = client.sealText("hello daemon");
  assert.notDeepEqual(c2s2, c2s);
  assert.equal(result.channel.openText(c2s2), "hello daemon");
});

test("device handshake works for trusted devices only", () => {
  const daemon = generateKeyPair();
  const device = generateKeyPair();
  const hs = startClientHandshake({ daemonKey: daemon.publicKey, deviceKeyPair: device });
  const accepted = respondToHello(hs.hello, {
    daemonKeyPair: daemon,
    isTrustedDevice: (pub) => toBase64Url(pub) === toBase64Url(device.publicKey),
    pairingSecret: () => null,
  });
  assert.ok(accepted);
  assert.equal(accepted.paired, false);
  assert.deepEqual(accepted.devicePublicKey, device.publicKey);
  assert.ok(hs.finish(accepted.reply));

  const hs2 = startClientHandshake({ daemonKey: daemon.publicKey, deviceKeyPair: generateKeyPair() });
  const rejected = respondToHello(hs2.hello, {
    daemonKeyPair: daemon,
    isTrustedDevice: () => false,
    pairingSecret: () => null,
  });
  assert.equal(rejected, null);
});

test("wrong pairing secret is rejected", () => {
  const { result } = handshake({
    pairing: true,
    secret: randomBytes(32),
    clientSecret: randomBytes(32),
  });
  assert.equal(result, null);
});

test("pairing rejected when no pairing window is open", () => {
  const { result } = handshake({ pairing: true, secret: null, clientSecret: randomBytes(32) });
  assert.equal(result, null);
});

test("hello for a different daemon key is rejected", () => {
  const daemon = generateKeyPair();
  const otherDaemon = generateKeyPair();
  const hs = startClientHandshake({
    daemonKey: otherDaemon.publicKey,
    deviceKeyPair: generateKeyPair(),
    pairingSecret: randomBytes(32),
  });
  const result = respondToHello(hs.hello, {
    daemonKeyPair: daemon,
    isTrustedDevice: () => true,
    pairingSecret: () => randomBytes(32),
  });
  assert.equal(result, null);
});

test("client rejects a reply from a man in the middle", () => {
  const secret = randomBytes(32);
  const daemon = generateKeyPair();
  const mitm = generateKeyPair();
  const device = generateKeyPair();
  const hs = startClientHandshake({
    daemonKey: daemon.publicKey, // client pinned the real daemon
    deviceKeyPair: device,
    pairingSecret: secret,
  });
  // relay-positioned attacker answers with its own keys — it cannot compute
  // ECDH(ce, DS) so its confirm frame must fail to authenticate
  const forged = respondToHello(hs.hello, {
    daemonKeyPair: mitm,
    isTrustedDevice: () => true,
    pairingSecret: () => secret,
  });
  if (forged) assert.equal(hs.finish(forged.reply), null);
});

test("tampered frames kill the channel; replays do not decrypt twice", () => {
  const secret = randomBytes(32);
  const { result, client } = handshake({ pairing: true, secret });
  const frame = client.sealText("sensitive");
  const tampered = frame.slice();
  tampered[0] = (tampered[0] + 1) % 256;
  assert.equal(result.channel.open(tampered), null);
  // original still decrypts at counter 0…
  assert.equal(result.channel.openText(frame), "sensitive");
  // …but a replay of the same ciphertext fails (counter moved on)
  assert.equal(result.channel.open(frame), null);
});

test("channel frames pack and unpack", () => {
  const payload = randomBytes(100);
  const packed = packChannelFrame(7, payload);
  const unpacked = unpackChannelFrame(packed);
  assert.equal(unpacked.ch, 7);
  assert.deepEqual(unpacked.payload, payload);
  assert.equal(unpackChannelFrame(new Uint8Array(3)), null);
  // works on subarray views too (ws may hand out pooled buffers)
  const view = new Uint8Array(concat(packed)).subarray(2);
  const unpacked2 = unpackChannelFrame(view);
  assert.equal(unpacked2.ch, 7);
  assert.deepEqual(unpacked2.payload, payload);
});

function concat(packed) {
  const out = new Uint8Array(2 + packed.length);
  out.set([0xaa, 0xbb], 0);
  out.set(packed, 2);
  return out;
}
