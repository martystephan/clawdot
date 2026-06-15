// Unit tests for the notification protocol additions: the notify.* client
// messages and the daemon↔relay push control frames. Runs against src/ via tsx:
//   pnpm --filter @clawdot/protocol test
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, decodeClient } from "../src/index.ts";
import {
  decodeDaemonRelayControl,
  decodeRelayDaemonControl,
} from "../src/tunnel.ts";

const client = (msg) => decodeClient({ v: PROTOCOL_VERSION, msg });

test("notify.register requires a token and a known platform", () => {
  assert.deepEqual(client({ type: "notify.register", token: "abc", platform: "ios" }), {
    type: "notify.register",
    token: "abc",
    platform: "ios",
  });
  // empty token rejected
  assert.equal(client({ type: "notify.register", token: "", platform: "ios" }), null);
  // unknown platform rejected
  assert.equal(client({ type: "notify.register", token: "abc", platform: "win" }), null);
});

test("notify.unregister decodes", () => {
  assert.deepEqual(client({ type: "notify.unregister" }), { type: "notify.unregister" });
});

test("push.send (daemon → relay) validates tokens + payload", () => {
  const ok = decodeDaemonRelayControl(
    JSON.stringify({ type: "push.send", tokens: ["t1", "t2"], title: "Clawdot", body: "x needs you" }),
  );
  assert.deepEqual(ok, {
    type: "push.send",
    tokens: ["t1", "t2"],
    title: "Clawdot",
    body: "x needs you",
  });
  // at least one token required
  assert.equal(
    decodeDaemonRelayControl(JSON.stringify({ type: "push.send", tokens: [], title: "a", body: "b" })),
    null,
  );
  // title required
  assert.equal(
    decodeDaemonRelayControl(JSON.stringify({ type: "push.send", tokens: ["t"], body: "b" })),
    null,
  );
});

test("push.dead (relay → daemon) decodes as a daemon control message", () => {
  const dead = decodeRelayDaemonControl(JSON.stringify({ type: "push.dead", tokens: ["gone"] }));
  assert.deepEqual(dead, { type: "push.dead", tokens: ["gone"] });
});

test("the relay does not accept push.send on its daemon-control channel", () => {
  // push.send is daemon→relay only; it must not parse as a relay→daemon control.
  assert.equal(
    decodeRelayDaemonControl(JSON.stringify({ type: "push.send", tokens: ["t"], title: "a", body: "b" })),
    null,
  );
});
