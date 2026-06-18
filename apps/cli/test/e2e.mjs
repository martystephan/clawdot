#!/usr/bin/env node
// End-to-end test: daemon over a real WebSocket.
// Verifies workspace tracking, filesystem browsing, ephemeral and persistent
// terminals (PTY round trip, scrollback replay, multi-device attach),
// settings, the remote browser (headless Chromium streamed via browser.*), and
// persistence of workspaces/settings across a daemon restart.
// Run via `pnpm --filter @clawdot/cli test`.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// --- Scenario 5: remote browser (headless Chromium streamed) -------------------
// A real browser tab on the daemon's machine, streamed as JPEG frames. Needs a
// Chrome to drive; with downloads disabled (set below) a machine without one
// reports browser.closed and we skip the streaming checks rather than fail.
const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    "<!doctype html><html><head><title>Clawdot Preview Test</title></head>" +
      "<body><h1 id='h'>hello browser</h1></body></html>",
  );
});
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
const pagePort = page.address().port;

const bw = connect();
await bw.open();
const openResultP = bw.next(
  (m) =>
    (m.type === "browser.opened" || m.type === "browser.closed") &&
    m.sessionId === "b1",
  "browser.opened",
);
bw.send({
  type: "browser.open",
  sessionId: "b1",
  port: pagePort,
  width: 800,
  height: 600,
  dpr: 1,
});
const openResult = await openResultP;
if (openResult.type === "browser.closed") {
  console.log(
    `skip - remote browser (no Chrome available: ${openResult.message ?? "?"})`,
  );
} else {
  const frame = await bw.next(
    (m) => m.type === "browser.frame" && m.sessionId === "b1",
    "browser.frame",
  );
  check(
    "the daemon streams JPEG screencast frames",
    typeof frame.data === "string" &&
      frame.data.length > 0 &&
      frame.meta.deviceWidth > 0,
  );

  const evalResP = bw.next(
    (m) => m.type === "browser.eval.result" && m.requestId === "e1",
    "browser.eval.result",
  );
  bw.send({
    type: "browser.eval",
    sessionId: "b1",
    requestId: "e1",
    expression: "document.title",
  });
  const evalRes = await evalResP;
  check(
    "browser.eval reads the live (server-side) DOM",
    evalRes.ok === true && JSON.parse(evalRes.value) === "Clawdot Preview Test",
  );

  const domResP = bw.next(
    (m) => m.type === "browser.dom" && m.requestId === "d1",
    "browser.dom",
  );
  bw.send({ type: "browser.dom", sessionId: "b1", requestId: "d1" });
  const domRes = await domResP;
  check(
    "browser.dom returns the serialized document",
    domRes.html.includes("hello browser"),
  );

  // A second concurrent tab on a DIFFERENT page proves sessions are independent.
  const page2 = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<!doctype html><html><head><title>Second Tab</title></head><body>two</body></html>",
    );
  });
  await new Promise((resolve) => page2.listen(0, "127.0.0.1", resolve));
  const page2Port = page2.address().port;
  const opened2P = bw.next(
    (m) => m.type === "browser.opened" && m.sessionId === "b2",
    "browser.opened b2",
  );
  bw.send({
    type: "browser.open",
    sessionId: "b2",
    port: page2Port,
    width: 640,
    height: 480,
    dpr: 1,
  });
  await opened2P;
  await bw.next(
    (m) => m.type === "browser.frame" && m.sessionId === "b2",
    "browser.frame b2",
  );
  const eval2P = bw.next(
    (m) => m.type === "browser.eval.result" && m.requestId === "e2",
    "browser.eval.result b2",
  );
  bw.send({
    type: "browser.eval",
    sessionId: "b2",
    requestId: "e2",
    expression: "document.title",
  });
  const eval2 = await eval2P;
  check(
    "concurrent sessions stream independent tabs on different URLs",
    eval2.ok === true && JSON.parse(eval2.value) === "Second Tab",
  );

  // Pause a tab, then resume — resuming repaints from the last frame at once.
  bw.send({ type: "browser.setActive", sessionId: "b1", active: false });
  const resumeP = bw.next(
    (m) => m.type === "browser.frame" && m.sessionId === "b1",
    "browser.frame b1 resume",
  );
  bw.send({ type: "browser.setActive", sessionId: "b1", active: true });
  const resumed = await resumeP;
  check(
    "browser.setActive resume repaints a backgrounded tab immediately",
    typeof resumed.data === "string" && resumed.data.length > 0,
  );

  bw.send({ type: "browser.close", sessionId: "b1" });
  bw.send({ type: "browser.close", sessionId: "b2" });
  page2.close();
}
bw.close();

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

const termList2P = c2.next((m) => m.type === "terminal.list", "terminal.list restart");
c2.send({ type: "terminal.list" });
const termList2 = await termList2P;
check(
  "terminal sessions do not survive a restart (a PTY cannot be rehydrated)",
  termList2.terminals.length === 0,
);
c2.close();

await stopDaemon();
// A listening server holds the event loop open, so the "exit" hook would never
// fire and the process would hang after the summary — close it explicitly.
page.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
