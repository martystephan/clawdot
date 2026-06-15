#!/usr/bin/env node
// End-to-end test: daemon over a real WebSocket.
// Verifies workspace tracking, filesystem browsing, ephemeral and persistent
// terminals (PTY round trip, scrollback replay, multi-device attach),
// settings, the web preview proxy (HTTP + WebSocket forwarding), and
// persistence of workspaces/settings across a daemon restart.
// Run via `pnpm --filter @clawdot/cli test`.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@clawdot/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8891;
const dataDir = mkdtempSync(join(tmpdir(), "clawdot-test-"));

let daemon = null;

async function startDaemon() {
  daemon = spawn("node", [join(here, "../dist/index.js"), "serve", "--port", String(PORT), "--no-relay"], {
    env: {
      ...process.env,
      CLAWDOT_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    daemon.stdout.on("data", (d) => d.toString().includes("listening") && resolve());
    daemon.on("error", reject);
    setTimeout(() => reject(new Error("daemon did not start")), 5000);
  });
}

async function stopDaemon() {
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  daemon.kill();
  await exited;
}

process.on("exit", () => {
  daemon?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures.push(name);
};

/** WebSocket client that records messages and awaits future ones. */
function connect() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const messages = [];
  const waiters = new Set();
  ws.onmessage = (e) => {
    const { msg } = JSON.parse(e.data);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.delete(w);
        w.resolve(msg);
      }
    }
  };
  return {
    messages,
    open: () =>
      new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("websocket failed to connect"));
      }),
    send: (msg) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, msg })),
    /** Resolves on the next *future* message matching pred. */
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

await startDaemon();

// --- Scenario 1: workspaces ----------------------------------------------------
const c1 = connect();
await c1.open();

const wsListP = c1.next((m) => m.type === "workspace.list", "workspace.list");
c1.send({ type: "workspace.list" });
const wsList = await wsListP;
check(
  "workspace.list includes the daemon cwd",
  wsList.workspaces.some((w) => w.cwd === process.cwd()),
);

// --- Scenario 2: filesystem browsing (workspace picker) -------------------------
const otherCwd = realpathSync(mkdtempSync(join(tmpdir(), "clawdot-ws-")));
process.on("exit", () => rmSync(otherCwd, { recursive: true, force: true }));

const fsListP = c1.next((m) => m.type === "fs.list", "fs.list");
c1.send({ type: "fs.list", path: otherCwd });
const fsList = await fsListP;
check(
  "fs.list resolves path, parent and starts empty",
  fsList.path === otherCwd && fsList.parent !== null && fsList.dirs.length === 0,
);

const mkdirP = c1.next((m) => m.type === "fs.list" || m.type === "fs.error", "fs.mkdir");
c1.send({ type: "fs.mkdir", path: otherCwd, name: "api" });
const mkdir = await mkdirP;
check(
  "fs.mkdir creates the folder and replies with its listing",
  mkdir.type === "fs.list" && mkdir.path === join(otherCwd, "api") && mkdir.parent === otherCwd,
);

// Symlinks that resolve to directories are browsable; broken ones are hidden.
symlinkSync(join(otherCwd, "api"), join(otherCwd, "linked"));
symlinkSync(join(otherCwd, "gone"), join(otherCwd, "broken"));
const fsList2P = c1.next((m) => m.type === "fs.list", "fs.list 2");
c1.send({ type: "fs.list", path: otherCwd });
const fsList2 = await fsList2P;
check(
  "new folder shows up in its parent's listing",
  fsList2.dirs.some((d) => d.name === "api" && d.path === join(otherCwd, "api")),
);
check(
  "symlinked directories are listed, broken symlinks are not",
  fsList2.dirs.some((d) => d.name === "linked") &&
    !fsList2.dirs.some((d) => d.name === "broken"),
);

const fsLinkedP = c1.next((m) => m.type === "fs.list", "fs.list symlink");
c1.send({ type: "fs.list", path: join(otherCwd, "linked") });
const fsLinked = await fsLinkedP;
check(
  "browsing a symlink switches to its canonical directory",
  fsLinked.path === join(otherCwd, "api") && fsLinked.parent === otherCwd,
);

const mkdirDupP = c1.next((m) => m.type === "fs.error", "duplicate mkdir error");
c1.send({ type: "fs.mkdir", path: otherCwd, name: "api" });
const mkdirDup = await mkdirDupP;
check("duplicate fs.mkdir is rejected as fs.error", mkdirDup.message.length > 0);

const mkdirBadP = c1.next((m) => m.type === "fs.error", "bad name error");
c1.send({ type: "fs.mkdir", path: otherCwd, name: "../escape" });
const mkdirBad = await mkdirBadP;
check(
  "fs.mkdir rejects names that leave the directory",
  mkdirBad.message.startsWith("invalid folder name"),
);
c1.close();

// --- Scenario 3: interactive terminal (PTY) ----------------------------------
const t1 = connect();
await t1.open();
const tObserver = connect();
await tObserver.open();

const openedP = t1.next((m) => m.type === "terminal.opened", "terminal.opened");
t1.send({ type: "terminal.open", cwd: otherCwd, cols: 80, rows: 24 });
const opened = await openedP;
check("terminal opens in the requested cwd", opened.cwd === otherCwd);

// The marker only appears assembled in the *executed* output — the echo of the
// typed command keeps the two halves apart — so seeing it proves a real shell
// ran the command, not just PTY echo.
let termOut = "";
const markerP = t1.next(
  (m) =>
    m.type === "terminal.data" &&
    (termOut += m.data).includes("OK_E2E_MARKER"),
  "executed command output",
);
t1.send({ type: "terminal.resize", terminalId: opened.terminalId, cols: 120, rows: 30 });
t1.send({
  type: "terminal.input",
  terminalId: opened.terminalId,
  data: "printf 'OK_%s\\n' E2E_MARKER\r",
});
await markerP;
check("terminal round-trips input through a live shell", true);

const exitP = t1.next(
  (m) => m.type === "terminal.exit" && m.terminalId === opened.terminalId,
  "terminal.exit",
);
t1.send({ type: "terminal.input", terminalId: opened.terminalId, data: "exit\r" });
const exited = await exitP;
check("shell exit is reported with its code", exited.exitCode === 0);
check(
  "terminal traffic stays on the opening connection",
  !tObserver.messages.some((m) => m.type?.startsWith("terminal.data")),
);
t1.close();
tObserver.close();

// Fallback cwd: a stale workspace path must not kill the terminal.
const t2 = connect();
await t2.open();
const fallbackP = t2.next((m) => m.type === "terminal.opened", "fallback terminal");
t2.send({ type: "terminal.open", cwd: "/no/such/dir/anywhere", cols: 80, rows: 24 });
const fallback = await fallbackP;
check("missing cwd falls back instead of failing", fallback.cwd !== "/no/such/dir/anywhere");
// Closing the connection (below) must reap this still-running shell — covered
// implicitly: stopDaemon would hang on a leaked child otherwise.
t2.close();

// --- Scenario 4: persistent terminal sessions + settings ----------------------
const p1 = connect();
await p1.open();
const sObserver = connect();
await sObserver.open();

const settingsP = p1.next((m) => m.type === "settings", "settings");
p1.send({ type: "settings.get" });
const settings = await settingsP;
check(
  "settings.get returns the default terminal agents",
  settings.terminalAgents.length === 2 &&
    settings.terminalAgents[0].name === "Claude Code",
);

const settingsBroadcastP = sObserver.next(
  (m) => m.type === "settings" && m.terminalAgents.length === 1,
  "settings broadcast",
);
p1.send({
  type: "settings.update",
  terminalAgents: [{ name: "Echo", command: "echo hi" }],
});
const updatedSettings = await settingsBroadcastP;
check(
  "settings.update is broadcast to every client",
  updatedSettings.terminalAgents[0].command === "echo hi",
);

// Persistent open only spawns — no output until a client attaches. Opening
// one also records its cwd as a workspace and broadcasts the new list.
const listBroadcastP = sObserver.next(
  (m) => m.type === "terminal.list" && m.terminals.length === 1,
  "terminal.list broadcast",
);
const wsBroadcastP = sObserver.next(
  (m) =>
    m.type === "workspace.list" &&
    m.workspaces.some((w) => w.cwd === otherCwd),
  "workspace.list broadcast",
);
const pOpenP = p1.next((m) => m.type === "terminal.opened", "persistent opened");
p1.send({
  type: "terminal.open",
  cwd: otherCwd,
  cols: 80,
  rows: 24,
  persistent: true,
  title: "Agent",
  command: "printf 'OK_%s\\n' PERSIST; exec cat",
});
const pOpened = await pOpenP;
const listBroadcast = await listBroadcastP;
check(
  "persistent terminal is announced via terminal.list with title and cwd",
  pOpened.persistent === true &&
    listBroadcast.terminals[0].title === "Agent" &&
    listBroadcast.terminals[0].cwd === otherCwd,
);
await wsBroadcastP;
check("persistent terminal records its cwd as a workspace", true);

let replay1 = "";
const attachedP = p1.next((m) => m.type === "terminal.attached", "attached");
const replay1P = p1.next(
  (m) =>
    m.type === "terminal.data" && (replay1 += m.data).includes("OK_PERSIST"),
  "scrollback replay",
);
p1.send({
  type: "terminal.attach",
  terminalId: pOpened.terminalId,
  cols: 80,
  rows: 24,
});
await attachedP;
await replay1P;
check("attach replays the agent's earlier output", true);

// One viewer at a time: a second device is refused, takeover moves the view.
const second = connect();
await second.open();
const busyP = second.next(
  (m) => m.type === "terminal.busy" && m.terminalId === pOpened.terminalId,
  "busy reply",
);
second.send({
  type: "terminal.attach",
  terminalId: pOpened.terminalId,
  cols: 90,
  rows: 26,
});
await busyP;
check("attach while another device is viewing answers terminal.busy", true);

const kickedP = p1.next(
  (m) => m.type === "terminal.busy" && m.terminalId === pOpened.terminalId,
  "kicked notice",
);
let takeoverReplay = "";
const takeoverReplayP = second.next(
  (m) =>
    m.type === "terminal.data" &&
    (takeoverReplay += m.data).includes("OK_PERSIST"),
  "takeover replay",
);
second.send({
  type: "terminal.attach",
  terminalId: pOpened.terminalId,
  cols: 90,
  rows: 26,
  takeover: true,
});
await kickedP;
await takeoverReplayP;
check("takeover moves the view here and notifies the previous device", true);
second.close();

// The opener disconnects — the agent must keep running for other devices.
p1.close();
const p2 = connect();
await p2.open();
const list2P = p2.next((m) => m.type === "terminal.list", "terminal.list 2");
p2.send({ type: "terminal.list" });
const list2 = await list2P;
check(
  "persistent terminal survives its opener's disconnect",
  list2.terminals.some((t) => t.terminalId === pOpened.terminalId),
);

let replay2 = "";
const replay2P = p2.next(
  (m) =>
    m.type === "terminal.data" && (replay2 += m.data).includes("OK_PERSIST"),
  "replay for a second device",
);
p2.send({
  type: "terminal.attach",
  terminalId: pOpened.terminalId,
  cols: 100,
  rows: 30,
});
await replay2P;
check("a different connection attaches and gets the replay", true);

const pExitP = p2.next(
  (m) => m.type === "terminal.exit" && m.terminalId === pOpened.terminalId,
  "persistent exit",
);
const listEmptyP = sObserver.next(
  (m) => m.type === "terminal.list" && m.terminals.length === 0,
  "terminal.list empty broadcast",
);
p2.send({ type: "terminal.close", terminalId: pOpened.terminalId });
await pExitP;
await listEmptyP;
check("killing notifies attached clients and is broadcast to the list", true);

const goneP = p2.next(
  (m) => m.type === "terminal.error" && m.terminalId === pOpened.terminalId,
  "gone error",
);
p2.send({
  type: "terminal.attach",
  terminalId: pOpened.terminalId,
  cols: 80,
  rows: 24,
});
const gone = await goneP;
check("attaching a dead terminal is a scoped error", gone.message.length > 0);
p2.close();
sObserver.close();

// --- Scenario 5: web preview proxy (HTTP + WebSocket forwarding) ---------------
// A fake dev server standing in for Vite & co: one HTTP route with headers
// the daemon must strip, an echoing POST route, and a WebSocket echo.
const target = createServer((req, res) => {
  if (req.url === "/hello") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "x-dev-server": "yes",
      "content-security-policy": "default-src 'none'",
      "x-frame-options": "DENY",
    });
    res.end("preview says hi");
  } else if (req.url === "/echo" && req.method === "POST") {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.concat(parts));
    });
  } else if (req.url === "/login") {
    // A cookie-session app: /login mints the session, /me requires it.
    res.writeHead(200, { "set-cookie": "session=abc123; Path=/; HttpOnly" });
    res.end("logged in");
  } else if (req.url === "/logout") {
    res.writeHead(200, { "set-cookie": "session=; Path=/; Max-Age=0" });
    res.end("logged out");
  } else if (req.url === "/me") {
    if ((req.headers.cookie ?? "").includes("session=abc123")) {
      res.writeHead(200);
      res.end("hello user");
    } else {
      res.writeHead(401);
      res.end("no session");
    }
  } else if (req.url === "/whoami") {
    res.writeHead(200);
    res.end(req.headers.cookie ?? "none");
  } else if (req.url === "/origin-echo") {
    res.writeHead(200);
    res.end(`${req.headers.origin ?? "none"} ${req.headers.referer ?? "none"}`);
  } else {
    res.writeHead(404);
    res.end("nope");
  }
});
new WebSocketServer({ server: target }).on("connection", (sock, req) => {
  // /cookie announces the handshake's cookie header so the jar is testable.
  if (req.url === "/cookie") sock.send(req.headers.cookie ?? "none");
  sock.on("message", (data) => sock.send(`echo:${data}`));
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const targetPort = target.address().port;
process.on("exit", () => target.close());

const pv = connect();
await pv.open();

const headP = pv.next((m) => m.type === "preview.head" && m.requestId === "r1", "preview.head");
const endP = pv.next((m) => m.type === "preview.end" && m.requestId === "r1", "preview.end");
pv.send({
  type: "preview.fetch",
  requestId: "r1",
  port: targetPort,
  method: "GET",
  path: "/hello",
  headers: [["accept", "text/plain"]],
});
const head = await headP;
await endP;
const body = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r1")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check(
  "preview.fetch proxies a local http server and streams the body",
  head.status === 200 &&
    head.headers.some(([k, v]) => k === "x-dev-server" && v === "yes") &&
    body === "preview says hi",
);
check(
  "frame-blocking and framing headers are stripped from the response",
  !head.headers.some(([k]) =>
    ["content-security-policy", "x-frame-options", "content-length"].includes(k),
  ),
);

const echoHeadP = pv.next((m) => m.type === "preview.head" && m.requestId === "r2", "echo head");
const echoEndP = pv.next((m) => m.type === "preview.end" && m.requestId === "r2", "echo end");
pv.send({
  type: "preview.fetch",
  requestId: "r2",
  port: targetPort,
  method: "POST",
  path: "/echo",
  headers: [],
  body: Buffer.from("round trip").toString("base64"),
});
await echoHeadP;
await echoEndP;
const echoBody = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r2")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check("preview.fetch carries request bodies to the target", echoBody === "round trip");

// Vite bound to `localhost` often listens on ::1 ONLY (macOS) — the proxy
// must fall back from 127.0.0.1 to the IPv6 loopback.
const v6Target = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("v6 only");
});
new WebSocketServer({ server: v6Target }).on("connection", (sock) => {
  sock.on("message", (data) => sock.send(`v6:${data}`));
});
await new Promise((resolve) => v6Target.listen(0, "::1", resolve));
const v6Port = v6Target.address().port;
process.on("exit", () => v6Target.close());

const v6EndP = pv.next((m) => m.type === "preview.end" && m.requestId === "r6", "v6 end");
pv.send({
  type: "preview.fetch",
  requestId: "r6",
  port: v6Port,
  method: "GET",
  path: "/",
  headers: [],
});
await v6EndP;
const v6Body = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r6")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check("preview.fetch falls back to the ::1 loopback (Vite on macOS)", v6Body === "v6 only");

const v6WsOpenedP = pv.next(
  (m) => m.type === "preview.ws.opened" && m.socketId === "s6",
  "v6 ws opened",
);
pv.send({ type: "preview.ws.open", socketId: "s6", port: v6Port, path: "/" });
await v6WsOpenedP;
const v6WsMsgP = pv.next(
  (m) => m.type === "preview.ws.message" && m.socketId === "s6",
  "v6 ws message",
);
pv.send({
  type: "preview.ws.send",
  socketId: "s6",
  data: Buffer.from("hi").toString("base64"),
  binary: false,
});
const v6WsMsg = await v6WsMsgP;
check(
  "preview websocket falls back to the ::1 loopback too",
  Buffer.from(v6WsMsg.data, "base64").toString() === "v6:hi",
);
pv.send({ type: "preview.ws.close", socketId: "s6" });

// A port nothing listens on (bound once to find a free one, then released)
// must be a scoped error.
const freeProbe = createServer();
await new Promise((resolve) => freeProbe.listen(0, resolve));
const deadPort = freeProbe.address().port;
await new Promise((resolve) => freeProbe.close(resolve));

const errP = pv.next((m) => m.type === "preview.error" && m.requestId === "r3", "preview.error");
pv.send({
  type: "preview.fetch",
  requestId: "r3",
  port: deadPort,
  method: "GET",
  path: "/",
  headers: [],
});
const fetchErr = await errP;
check("a dead port is a scoped preview.error, not a hang", fetchErr.message.length > 0);

const wsOpenedP = pv.next((m) => m.type === "preview.ws.opened" && m.socketId === "s1", "ws opened");
pv.send({ type: "preview.ws.open", socketId: "s1", port: targetPort, path: "/" });
await wsOpenedP;
const wsMsgP = pv.next((m) => m.type === "preview.ws.message" && m.socketId === "s1", "ws message");
pv.send({
  type: "preview.ws.send",
  socketId: "s1",
  data: Buffer.from("hmr").toString("base64"),
  binary: false,
});
const wsMsg = await wsMsgP;
check(
  "preview websocket round-trips through the daemon",
  Buffer.from(wsMsg.data, "base64").toString() === "echo:hmr" && wsMsg.binary === false,
);
const wsClosedP = pv.next((m) => m.type === "preview.ws.closed" && m.socketId === "s1", "ws closed");
pv.send({ type: "preview.ws.close", socketId: "s1", code: 1000 });
const wsClosed = await wsClosedP;
check("preview websocket closes cleanly", wsClosed.code === 1000);

const wsFailP = pv.next((m) => m.type === "preview.ws.closed" && m.socketId === "s2", "ws fail");
pv.send({ type: "preview.ws.open", socketId: "s2", port: deadPort, path: "/" });
await wsFailP;
check("a websocket to a dead port reports preview.ws.closed", true);

// Absolute-url fetches: refusing hosts off the allowlist is what keeps the
// daemon from being an open proxy, so test the refusal BEFORE allowing.
const urlDeniedP = pv.next(
  (m) => m.type === "preview.error" && m.requestId === "r4",
  "url denied",
);
pv.send({
  type: "preview.fetch",
  requestId: "r4",
  port: targetPort,
  method: "GET",
  path: "/hello",
  url: `http://127.0.0.1:${targetPort}/hello`,
  headers: [],
});
const denied = await urlDeniedP;
check(
  "an absolute-url fetch to a non-allowlisted host is refused",
  denied.message.includes("not allowed"),
);

const hostsBroadcastP = pv.next(
  (m) => m.type === "settings" && m.previewAllowedHosts.length === 2,
  "allowlist broadcast",
);
pv.send({
  type: "settings.update",
  terminalAgents: [{ name: "Echo", command: "echo hi" }],
  previewAllowedHosts: ["127.0.0.1", "API.Example.COM"],
});
const hostsSettings = await hostsBroadcastP;
check(
  "settings.update normalizes and broadcasts the preview allowlist",
  hostsSettings.previewAllowedHosts.includes("127.0.0.1") &&
    hostsSettings.previewAllowedHosts.includes("api.example.com"),
);

const urlHeadP = pv.next((m) => m.type === "preview.head" && m.requestId === "r5", "url head");
const urlEndP = pv.next((m) => m.type === "preview.end" && m.requestId === "r5", "url end");
pv.send({
  type: "preview.fetch",
  requestId: "r5",
  port: targetPort,
  method: "GET",
  path: "/hello",
  url: `http://127.0.0.1:${targetPort}/hello`,
  headers: [],
});
const urlHead = await urlHeadP;
await urlEndP;
const urlBody = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r5")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check(
  "an allowlisted host serves absolute-url fetches",
  urlHead.status === 200 && urlBody === "preview says hi",
);

// --- Cookie jar: the daemon holds previewed apps' sessions (the browser
// can't — service-worker responses can't set cookies). ---------------------
let cookieReq = 0;
const previewGet = async (conn, port, path) => {
  const id = `rc${cookieReq++}`;
  const headP = conn.next(
    (m) => m.type === "preview.head" && m.requestId === id,
    `head ${path}`,
  );
  const endP = conn.next(
    (m) => m.type === "preview.end" && m.requestId === id,
    `end ${path}`,
  );
  conn.send({
    type: "preview.fetch",
    requestId: id,
    port,
    method: "GET",
    path,
    headers: [],
  });
  const head = await headP;
  await endP;
  const body = Buffer.concat(
    conn.messages
      .filter((m) => m.type === "preview.body" && m.requestId === id)
      .map((m) => Buffer.from(m.chunk, "base64")),
  ).toString();
  return { head, body };
};

const meBefore = await previewGet(pv, targetPort, "/me");
check("a cookie-session route 401s before login", meBefore.head.status === 401);

const login = await previewGet(pv, targetPort, "/login");
check(
  "set-cookie is captured into the jar and still stripped from the client",
  login.head.status === 200 &&
    !login.head.headers.some(([k]) => k === "set-cookie"),
);

const meAfter = await previewGet(pv, targetPort, "/me");
check(
  "the jar replays the session on the next request",
  meAfter.head.status === 200 && meAfter.body === "hello user",
);

// The session rides WebSocket handshakes too (Socket.IO-style cookie auth).
const wsCookieP = pv.next(
  (m) => m.type === "preview.ws.message" && m.socketId === "s7",
  "ws cookie",
);
pv.send({ type: "preview.ws.open", socketId: "s7", port: targetPort, path: "/cookie" });
const wsCookie = await wsCookieP;
check(
  "the jar replays the session on websocket handshakes",
  Buffer.from(wsCookie.data, "base64").toString().includes("session=abc123"),
);
pv.send({ type: "preview.ws.close", socketId: "s7" });

// Isolation: a different port must never see another app's session.
const otherTarget = createServer((req, res) => {
  res.writeHead(200);
  res.end(req.headers.cookie ?? "none");
});
await new Promise((resolve) => otherTarget.listen(0, "127.0.0.1", resolve));
const otherPort = otherTarget.address().port;
const leak = await previewGet(pv, otherPort, "/whoami");
check("cookies never leak to a different port", leak.body === "none");

// The jar is daemon-scoped: a reconnecting phone keeps the app's session.
const pvAgain = connect();
await pvAgain.open();
const meOther = await previewGet(pvAgain, targetPort, "/me");
check(
  "the session survives a reconnect (jar is daemon-scoped, not per-connection)",
  meOther.head.status === 200,
);
pvAgain.close();

await previewGet(pv, targetPort, "/logout");
const meLoggedOut = await previewGet(pv, targetPort, "/me");
check("Max-Age=0 logs the session out of the jar", meLoggedOut.head.status === 401);

// Origin/Referer synthesis: service workers never see these headers (the
// browser attaches them below the worker), so the daemon must emulate the
// browser's rules from pagePort alone — Origin on non-GET/HEAD requests
// (what CSRF checks like Better Auth's care about), Referer on everything.
const originHeadP = pv.next(
  (m) => m.type === "preview.head" && m.requestId === "r7",
  "origin-echo head",
);
const originEndP = pv.next(
  (m) => m.type === "preview.end" && m.requestId === "r7",
  "origin-echo end",
);
pv.send({
  type: "preview.fetch",
  requestId: "r7",
  port: targetPort,
  method: "POST",
  path: "/origin-echo",
  pagePort: 5173,
  headers: [],
});
await originHeadP;
await originEndP;
const originEcho = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r7")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check(
  "POSTs with pagePort carry synthesized localhost Origin/Referer",
  originEcho === "http://localhost:5173 http://localhost:5173/",
);

const getHeadP = pv.next(
  (m) => m.type === "preview.head" && m.requestId === "r8",
  "origin-echo get head",
);
const getEndP = pv.next(
  (m) => m.type === "preview.end" && m.requestId === "r8",
  "origin-echo get end",
);
pv.send({
  type: "preview.fetch",
  requestId: "r8",
  port: targetPort,
  method: "GET",
  path: "/origin-echo",
  pagePort: 5173,
  headers: [],
});
await getHeadP;
await getEndP;
const getEcho = Buffer.concat(
  pv.messages
    .filter((m) => m.type === "preview.body" && m.requestId === "r8")
    .map((m) => Buffer.from(m.chunk, "base64")),
).toString();
check(
  "GETs with pagePort get Referer but no Origin (browser behavior)",
  getEcho === "none http://localhost:5173/",
);

const bareEcho = await previewGet(pv, targetPort, "/origin-echo");
check(
  "without pagePort nothing is invented",
  bareEcho.body === "none none",
);
pv.close();

// --- Scenario 6: daemon restart → workspaces and settings survive --------------
await stopDaemon();
await startDaemon();

const c2 = connect();
await c2.open();
const wsList2P = c2.next((m) => m.type === "workspace.list", "workspace.list restart");
c2.send({ type: "workspace.list" });
const wsList2 = await wsList2P;
check(
  "workspaces survived the restart",
  wsList2.workspaces.some((w) => w.cwd === otherCwd),
);

const wsRemoveP = c2.next((m) => m.type === "workspace.list", "workspace.remove");
c2.send({ type: "workspace.remove", cwd: otherCwd });
const wsRemoved = await wsRemoveP;
check(
  "workspace.remove drops the workspace from the list",
  !wsRemoved.workspaces.some((w) => w.cwd === otherCwd),
);

const settings2P = c2.next((m) => m.type === "settings", "settings restart");
c2.send({ type: "settings.get" });
const settings2 = await settings2P;
check(
  "settings survived the restart",
  settings2.terminalAgents.length === 1 &&
    settings2.terminalAgents[0].name === "Echo",
);
check(
  "the preview allowlist survived the restart",
  settings2.previewAllowedHosts.includes("127.0.0.1"),
);

const termList2P = c2.next((m) => m.type === "terminal.list", "terminal.list restart");
c2.send({ type: "terminal.list" });
const termList2 = await termList2P;
check(
  "terminal sessions do not survive a restart (a PTY cannot be rehydrated)",
  termList2.terminals.length === 0,
);
c2.close();

await stopDaemon();
// The exit hook can't do this: listening servers hold the event loop open,
// so "exit" would never fire and the process would hang after the summary.
target.close();
v6Target.close();
otherTarget.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
