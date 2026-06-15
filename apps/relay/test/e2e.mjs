#!/usr/bin/env node
// Relay e2e: a fake daemon and fake clients run the REAL E2E handshake
// through a real relay socket. Verifies room bridging, channel multiplexing,
// pairing + device reconnect, ciphertext-only forwarding, and teardown
// notifications. Build relay + protocol first; runs dist/.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateKeyPair,
  packChannelFrame,
  randomBytes,
  respondToHello,
  roomIdFor,
  startClientHandshake,
  toBase64Url,
  unpackChannelFrame,
} from "@clawdot/protocol/tunnel";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9719;

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures.push(name);
};

const relay = spawn("node", [join(here, "../dist/index.js"), "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "inherit"],
});
process.on("exit", () => relay.kill());
await new Promise((resolve, reject) => {
  relay.stdout.on("data", (d) => d.toString().includes("listening") && resolve());
  relay.on("error", reject);
  setTimeout(() => reject(new Error("relay did not start")), 5000);
});

const URL_ = `ws://localhost:${PORT}/v1`;

/** WebSocket wrapper that queues frames and awaits future ones. */
function socket() {
  const ws = new WebSocket(URL_);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const waiters = [];
  const closed = new Promise((resolve) => (ws.onclose = () => resolve()));
  ws.onmessage = (e) => {
    const frame =
      typeof e.data === "string" ? JSON.parse(e.data) : new Uint8Array(e.data);
    const w = waiters.shift();
    if (w) w(frame);
    else frames.push(frame);
  };
  return {
    ws,
    frames,
    closed,
    open: () =>
      new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("connect failed"));
        setTimeout(() => reject(new Error("connect timeout")), 5000);
      }),
    next: (label = "frame") =>
      new Promise((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) return resolve(queued);
        const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 5000);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      }),
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

// --- Setup: identities --------------------------------------------------------
const daemonKeys = generateKeyPair();
const deviceKeys = generateKeyPair();
const pairingSecret = randomBytes(32);
const room = roomIdFor(daemonKeys.publicKey);
const trusted = new Set();

// --- Client before daemon → daemon-offline -----------------------------------
const early = socket();
await early.open();
early.send(JSON.stringify({ role: "client", room }));
const earlyCtl = await early.next("offline control");
check("client without daemon is turned away", earlyCtl.type === "close" && earlyCtl.reason === "daemon-offline");
await early.closed;

// --- Daemon registers ----------------------------------------------------------
const daemon = socket();
await daemon.open();
daemon.send(JSON.stringify({ role: "daemon", room }));

/** Daemon-side automaton: answer handshakes, echo one encrypted message. */
const daemonChannels = new Map();
const handleDaemonFrame = (frame) => {
  if (frame instanceof Uint8Array) {
    const unpacked = unpackChannelFrame(frame);
    if (!unpacked) return;
    const state = daemonChannels.get(unpacked.ch);
    if (!state) return;
    if (!state.channel) {
      const result = respondToHello(unpacked.payload, {
        daemonKeyPair: daemonKeys,
        isTrustedDevice: (pub) => trusted.has(toBase64Url(pub)),
        pairingSecret: () => state.allowPairing ? pairingSecret : null,
      });
      if (!result) return; // reject silently — channel stays dead
      state.channel = result.channel;
      if (result.paired) trusted.add(toBase64Url(result.devicePublicKey));
      daemon.send(packChannelFrame(unpacked.ch, result.reply));
      return;
    }
    const text = state.channel.openText(unpacked.payload);
    state.received.push(text);
    daemon.send(
      packChannelFrame(unpacked.ch, state.channel.sealText(`echo:${text}`)),
    );
  } else if (frame.type === "channel.open") {
    daemonChannels.set(frame.ch, {
      channel: null,
      received: [],
      allowPairing: true,
      closed: false,
    });
  } else if (frame.type === "channel.close") {
    const state = daemonChannels.get(frame.ch);
    if (state) state.closed = true;
  }
};
// Pump frames continuously (the shared `next` consumer is used by clients only).
daemon.ws.onmessage = (e) => {
  const frame =
    typeof e.data === "string" ? JSON.parse(e.data) : new Uint8Array(e.data);
  handleDaemonFrame(frame);
};

// --- Client pairs through the relay -------------------------------------------
const c1 = socket();
await c1.open();
c1.send(JSON.stringify({ role: "client", room }));
const ready1 = await c1.next("ready");
check("client got ready once bridged", ready1.type === "ready");

const hs1 = startClientHandshake({
  daemonKey: daemonKeys.publicKey,
  deviceKeyPair: deviceKeys,
  pairingSecret,
});
c1.send(hs1.hello);
const reply1 = await c1.next("handshake reply");
const chan1 = hs1.finish(reply1);
check("pairing handshake succeeded through the relay", chan1 !== null);
check("daemon registered the paired device", trusted.has(toBase64Url(deviceKeys.publicKey)));

c1.send(chan1.sealText("hello over the tunnel"));
const echo1 = chan1.openText(await c1.next("echo"));
check("encrypted round-trip through relay", echo1 === "echo:hello over the tunnel");

// --- Second client on its own channel (device mode, no secret) ----------------
const c2 = socket();
await c2.open();
c2.send(JSON.stringify({ role: "client", room }));
await c2.next("ready 2");
const hs2 = startClientHandshake({
  daemonKey: daemonKeys.publicKey,
  deviceKeyPair: deviceKeys, // now trusted — reconnects without a secret
});
c2.send(hs2.hello);
const chan2 = hs2.finish(await c2.next("handshake reply 2"));
check("trusted device reconnects without pairing secret", chan2 !== null);

c2.send(chan2.sealText("second channel"));
const echo2 = chan2.openText(await c2.next("echo 2"));
check("second client has an independent channel", echo2 === "echo:second channel");
check(
  "daemon saw two distinct channels",
  daemonChannels.size === 2 && [...daemonChannels.keys()][0] !== [...daemonChannels.keys()][1],
);

// First client's channel still works (counters independent per channel).
c1.send(chan1.sealText("still alive"));
check("first channel unaffected by second", chan1.openText(await c1.next("echo 3")) === "echo:still alive");

// --- Stranger with no credentials gets nothing --------------------------------
const c3 = socket();
await c3.open();
c3.send(JSON.stringify({ role: "client", room }));
await c3.next("ready 3");
const strangerHs = startClientHandshake({
  daemonKey: daemonKeys.publicKey,
  deviceKeyPair: generateKeyPair(), // unknown device, no pairing secret
});
c3.send(strangerHs.hello);
const strangerReply = await Promise.race([
  c3.next("stranger reply"),
  new Promise((resolve) => setTimeout(() => resolve("nothing"), 1200)),
]);
check("unknown device gets no handshake reply", strangerReply === "nothing");
c3.close();

// --- Client disconnect → channel.close at daemon ------------------------------
const ch1Id = [...daemonChannels.keys()][0];
c1.close();
await new Promise((r) => setTimeout(r, 300));
check("daemon notified when client leaves", daemonChannels.get(ch1Id)?.closed === true);

// --- Daemon disconnect → remaining clients closed ------------------------------
daemon.close();
const closeCtl = await c2.next("daemon-gone control");
check("clients told when daemon goes away", closeCtl.type === "close" && closeCtl.reason === "daemon-gone");
await c2.closed;

relay.kill();

// --- Static web app hosting (--static) ------------------------------------------
const webDir = mkdtempSync(join(tmpdir(), "clawdot-web-"));
process.on("exit", () => rmSync(webDir, { recursive: true, force: true }));
writeFileSync(join(webDir, "index.html"), "<html>clawdot</html>");
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");

const staticRelay = spawn(
  "node",
  [join(here, "../dist/index.js"), "--port", String(PORT + 1), "--static", webDir],
  { stdio: ["ignore", "pipe", "inherit"] },
);
process.on("exit", () => staticRelay.kill());
await new Promise((resolve) =>
  staticRelay.stdout.on("data", (d) => d.toString().includes("listening") && resolve()),
);
const base = `http://localhost:${PORT + 1}`;
const index = await fetch(base + "/");
check(
  "static: index.html served at /",
  index.status === 200 &&
    index.headers.get("content-type")?.startsWith("text/html") &&
    (await index.text()).includes("clawdot"),
);
const asset = await fetch(base + "/assets/app.js");
check(
  "static: assets served with the right type",
  asset.status === 200 && asset.headers.get("content-type")?.startsWith("text/javascript"),
);
const fallback = await fetch(base + "/some/deep/route");
check(
  "static: unknown paths fall back to index.html (SPA)",
  fallback.status === 200 && (await fallback.text()).includes("clawdot"),
);
const traversal = await fetch(base + "/..%2f..%2fetc%2fpasswd");
check(
  "static: traversal attempts never escape the root",
  (await traversal.text()).includes("clawdot") || traversal.status === 404,
);
const health = await fetch(base + "/healthz");
check("static: /healthz still answers", (await health.text()) === "ok");
// Origin-mode previews live on p<port>.<host> wildcard subdomains pointed at
// this same relay — static serving must stay host-agnostic.
const subdomain = await fetch(base + "/", {
  headers: { host: "p5173.clawdot.example.com" },
});
check(
  "static: any Host header serves the app (wildcard preview subdomains)",
  subdomain.status === 200 && (await subdomain.text()).includes("clawdot"),
);
staticRelay.kill();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
