#!/usr/bin/env node
// Remote-access e2e: real relay + real daemon. A "phone" pairs through the
// relay with a ticket minted over the local socket, then drives a full
// terminal round trip (open → input → output → exit) entirely through the
// encrypted tunnel. Also covers: pairing privilege split, one-shot secrets,
// device reconnect, and daemon surviving a relay restart.
// Build cli, relay and protocol first; runs dist/.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@clawdot/protocol";
import {
  decodeTicket,
  generateKeyPair,
  roomIdFor,
  startClientHandshake,
} from "@clawdot/protocol/tunnel";

const here = dirname(fileURLToPath(import.meta.url));
const RELAY_PORT = 9821;
const DAEMON_PORT = 8893;
const dataDir = mkdtempSync(join(tmpdir(), "clawdot-relay-test-"));

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures.push(name);
};

let relay = null;
let daemon = null;
process.on("exit", () => {
  relay?.kill();
  daemon?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

async function startRelay() {
  relay = spawn(
    "node",
    [join(here, "../../relay/dist/index.js"), "--port", String(RELAY_PORT)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    relay.stdout.on("data", (d) => d.toString().includes("listening") && resolve());
    relay.on("error", reject);
    setTimeout(() => reject(new Error("relay did not start")), 5000);
  });
}

async function startDaemon() {
  daemon = spawn(
    "node",
    [
      join(here, "../dist/index.js"),
      "serve",
      "--port",
      String(DAEMON_PORT),
      "--relay",
      `ws://localhost:${RELAY_PORT}/v1`,
    ],
    {
      env: {
        ...process.env,
        CLAWDOT_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await new Promise((resolve, reject) => {
    let out = "";
    daemon.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("relay: connected")) resolve();
    });
    daemon.on("error", reject);
    setTimeout(() => reject(new Error("daemon did not reach the relay")), 5000);
  });
}

await startRelay();
await startDaemon();

// --- Mint a pairing ticket over the LOCAL socket -------------------------------
const ticketMsg = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${DAEMON_PORT}`);
  ws.onopen = () =>
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, msg: { type: "pair.start" } }));
  ws.onmessage = (e) => {
    const { msg } = JSON.parse(e.data);
    if (msg.type === "pair.ticket" || msg.type === "error") {
      ws.close();
      resolve(msg);
    }
  };
  setTimeout(() => reject(new Error("no pair.ticket")), 5000);
});
check("local socket can mint a pairing ticket", ticketMsg.type === "pair.ticket");
check(
  "ticket carries the relay url and a web-app pairing link",
  ticketMsg.relayUrl === `ws://localhost:${RELAY_PORT}/v1` &&
    ticketMsg.url === `http://localhost:${RELAY_PORT}/#pair=${ticketMsg.ticket}`,
);
const ticket = decodeTicket(ticketMsg.ticket);
check("ticket decodes", ticket !== null);

// --- A "phone": protocol client over the encrypted tunnel ----------------------
function tunnelClient(deviceKeyPair, { pairingSecret } = {}) {
  const ws = new WebSocket(`ws://localhost:${RELAY_PORT}/v1`);
  ws.binaryType = "arraybuffer";
  const messages = [];
  const waiters = new Set();
  let channel = null;
  let hs = null;
  const established = new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), 3000); // null = no handshake reply
    ws.onopen = () =>
      ws.send(JSON.stringify({ role: "client", room: roomOf(ticket) }));
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const ctl = JSON.parse(e.data);
        if (ctl.type === "ready") {
          hs = startClientHandshake({
            daemonKey: ticket.daemonKey,
            deviceKeyPair,
            pairingSecret,
          });
          ws.send(hs.hello);
        }
        if (ctl.type === "close") {
          clearTimeout(timer);
          resolve(null);
        }
        return;
      }
      const frame = new Uint8Array(e.data);
      if (!channel) {
        channel = hs.finish(frame);
        clearTimeout(timer);
        resolve(channel);
        return;
      }
      const text = channel.openText(frame);
      if (text === null) return;
      const { msg } = JSON.parse(text);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.delete(w);
          w.resolve(msg);
        }
      }
      messages.push(msg);
    };
    ws.onerror = () => reject(new Error("tunnel client failed to connect"));
  });
  return {
    established,
    messages,
    send: (msg) =>
      ws.send(channel.sealText(JSON.stringify({ v: PROTOCOL_VERSION, msg }))),
    next: (pred, label = "message") =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${label}`)),
          10_000,
        );
        waiters.add({
          pred,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      }),
    close: () => ws.close(),
  };
}

// Room id is derivable from the daemon key — mirror of the daemon's derivation.
const roomOf = (t) => roomIdFor(t.daemonKey);

const device = generateKeyPair();
const phone = tunnelClient(device, { pairingSecret: ticket.secret });
const chan = await phone.established;
check("phone paired through the relay", chan !== null);

// --- Full terminal round trip through the tunnel --------------------------------
const openedP = phone.next((m) => m.type === "terminal.opened", "terminal.opened");
phone.send({
  type: "terminal.open",
  cols: 80,
  rows: 24,
  persistent: true,
  title: "Agent",
  command: "printf 'OK_%s\\n' TUNNEL; exec cat",
});
const opened = await openedP;
check("persistent terminal opened over the tunnel", opened.persistent === true);

let replay = "";
const replayP = phone.next(
  (m) => m.type === "terminal.data" && (replay += m.data).includes("OK_TUNNEL"),
  "scrollback replay",
);
phone.send({
  type: "terminal.attach",
  terminalId: opened.terminalId,
  cols: 80,
  rows: 24,
});
await replayP;
check("attach replays the terminal's output through the tunnel", true);

let echoed = "";
const echoP = phone.next(
  (m) => m.type === "terminal.data" && (echoed += m.data).includes("hello-tunnel"),
  "echoed input",
);
phone.send({
  type: "terminal.input",
  terminalId: opened.terminalId,
  data: "hello-tunnel\r",
});
await echoP;
check("keystrokes round-trip through the encrypted tunnel", true);

// --- Privilege split: remote clients cannot mint tickets -----------------------
const pairErrP = phone.next((m) => m.type === "error", "pair error");
phone.send({ type: "pair.start" });
const pairErr = await pairErrP;
check(
  "remote pair.start is refused",
  pairErr.message.includes("locally"),
);

// --- One-shot secret: same ticket cannot pair a second device ------------------
const intruder = tunnelClient(generateKeyPair(), { pairingSecret: ticket.secret });
check("used pairing secret rejects the next device", (await intruder.established) === null);
intruder.close();

// --- Device management over the LOCAL socket ------------------------------------
function localRequest(msg, replyType) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${DAEMON_PORT}`);
    ws.onopen = () => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, msg }));
    ws.onmessage = (e) => {
      const reply = JSON.parse(e.data).msg;
      if (reply.type === replyType || reply.type === "error") {
        ws.close();
        resolve(reply);
      }
    };
    setTimeout(() => reject(new Error(`no ${replyType}`)), 5000);
  });
}

const deviceList = await localRequest({ type: "device.list" }, "device.list");
check(
  "local device.list shows the paired phone",
  deviceList.devices?.length === 1 && typeof deviceList.devices[0].addedAt === "number",
);

// remote clients must not manage devices
const remoteListP = phone.next((m) => m.type === "error", "remote device error");
phone.send({ type: "device.list" });
check(
  "remote device.list is refused",
  (await remoteListP).message.includes("locally"),
);

// --- Device reconnect without a secret ------------------------------------------
phone.close();
const phone2 = tunnelClient(device); // same device key, no secret
check("paired device reconnects without a ticket", (await phone2.established) !== null);
// The persistent terminal survived the phone's disconnect — reattach replays it.
let replay2 = "";
const replay2P = phone2.next(
  (m) => m.type === "terminal.data" && (replay2 += m.data).includes("OK_TUNNEL"),
  "replay after reconnect",
);
phone2.send({
  type: "terminal.attach",
  terminalId: opened.terminalId,
  cols: 80,
  rows: 24,
});
await replay2P;
check("terminal session survives the disconnect and replays on reattach", true);
phone2.close();

// --- Daemon survives a relay restart -------------------------------------------
relay.kill();
await new Promise((r) => setTimeout(r, 300));
await startRelay();
// daemon reconnects with backoff (1s, 2s, ...) — poll until a client gets through
let reconnected = null;
for (let attempt = 0; attempt < 8 && !reconnected; attempt++) {
  await new Promise((r) => setTimeout(r, 1000));
  const probe = tunnelClient(device);
  reconnected = await probe.established;
  probe.close();
}
check("daemon reconnects after a relay restart", reconnected !== null);

// --- Revocation blocks the next handshake ----------------------------------------
const revoked = await localRequest(
  { type: "device.revoke", key: deviceList.devices[0].key },
  "device.list",
);
check("device.revoke empties the registry", revoked.devices?.length === 0);
const phone3 = tunnelClient(device); // same key, but no longer trusted
check("revoked device cannot reconnect", (await phone3.established) === null);
phone3.close();

// --- Unlimited pairing: a never-expiring token that pairs many devices ---------
// Turn the local-only config flag on and restart; the token now never expires
// and a successful pairing does NOT consume the window.
daemon.kill();
await new Promise((r) => setTimeout(r, 300));
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ unlimitedPairing: true }));
await startDaemon();

const unlimitedMsg = await localRequest({ type: "pair.start" }, "pair.ticket");
check(
  "unlimited pairing mints a token with no expiry",
  unlimitedMsg.type === "pair.ticket" && unlimitedMsg.expiresAt === null,
);
const unlimitedSecret = decodeTicket(unlimitedMsg.ticket).secret;

const deviceA = tunnelClient(generateKeyPair(), { pairingSecret: unlimitedSecret });
check("first device pairs on the unlimited token", (await deviceA.established) !== null);
deviceA.close();

// Same secret again — an ordinary window would now be spent; this one is not.
const deviceB = tunnelClient(generateKeyPair(), { pairingSecret: unlimitedSecret });
check("a second device pairs on the same unlimited token", (await deviceB.established) !== null);
deviceB.close();

daemon.kill();
relay.kill();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
