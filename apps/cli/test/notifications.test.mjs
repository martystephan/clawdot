// Unit tests for the daemon's push wiring: the generic payload, the
// PushNotifier gating, and the per-device token registry on TunnelService.
// Runs against src/ via tsx:
//   tsx --test test/notifications.test.mjs  (part of `pnpm --filter @clawdot/cli test`)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, toBase64Url } from "@clawdot/protocol/tunnel";
import { PushNotifier, attentionPayload } from "../src/notifications.ts";
import { TunnelService } from "../src/tunnel.ts";

test("attentionPayload names the session but never task content", () => {
  assert.deepEqual(attentionPayload({ title: "deploy bot" }), {
    title: "Clawdot",
    body: "deploy bot needs your attention",
  });
  // blank title falls back to a neutral name
  assert.deepEqual(attentionPayload({ title: "   " }), {
    title: "Clawdot",
    body: "Agent needs your attention",
  });
});

test("PushNotifier sends one push.send to every registered token", () => {
  const sent = [];
  const notifier = new PushNotifier({
    tunnel: { pushTargets: () => [{ token: "a", platform: "ios" }, { token: "b", platform: "ios" }] },
    send: (msg) => sent.push(msg),
    enabled: () => true,
  });
  notifier.notify({ title: "sess", terminalId: "x", cwd: "/", createdAt: 0 });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "push.send",
    tokens: ["a", "b"],
    title: "Clawdot",
    body: "sess needs your attention",
  });
});

test("PushNotifier stays silent when disabled or no targets", () => {
  const sent = [];
  const base = { send: (m) => sent.push(m) };
  new PushNotifier({
    ...base,
    tunnel: { pushTargets: () => [{ token: "a", platform: "ios" }] },
    enabled: () => false,
  }).notify({ title: "s" });
  new PushNotifier({
    ...base,
    tunnel: { pushTargets: () => [] },
    enabled: () => true,
  }).notify({ title: "s" });
  assert.equal(sent.length, 0);
});

test("TunnelService stores, lists, and prunes push tokens per device", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdot-notify-"));
  try {
    const tunnel = new TunnelService(dir, "wss://relay.example/v1");
    const device = generateKeyPair();
    const key = toBase64Url(device.publicKey);

    // unknown device: no-op
    tunnel.setPushToken("not-a-device", "tok", "ios");
    assert.deepEqual(tunnel.pushTargets(), []);

    tunnel.registerDevice(device.publicKey);
    tunnel.setPushToken(key, "tok-1", "ios");
    assert.deepEqual(tunnel.pushTargets(), [{ token: "tok-1", platform: "ios" }]);

    // re-register refreshes the token in place
    tunnel.setPushToken(key, "tok-2", "ios");
    assert.deepEqual(tunnel.pushTargets(), [{ token: "tok-2", platform: "ios" }]);

    // a dead token reported by the relay is pruned
    tunnel.prunePushTokens(["tok-2"]);
    assert.deepEqual(tunnel.pushTargets(), []);

    // survives a reload from disk
    tunnel.setPushToken(key, "tok-3", "ios");
    const reloaded = new TunnelService(dir, "wss://relay.example/v1");
    assert.deepEqual(reloaded.pushTargets(), [{ token: "tok-3", platform: "ios" }]);

    // clear removes it
    reloaded.clearPushToken(key);
    assert.deepEqual(reloaded.pushTargets(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-registering a token claims it off other device records", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdot-notify-"));
  try {
    const tunnel = new TunnelService(dir, "wss://relay.example/v1");
    // One phone, re-paired three times: three device records, one FCM token.
    for (let i = 0; i < 3; i++) {
      const device = generateKeyPair();
      tunnel.registerDevice(device.publicKey);
      tunnel.setPushToken(toBase64Url(device.publicKey), "phone-token", "ios");
    }
    // Each register claims the token off the older records, so only the newest
    // holds it and the fan-out targets the device a single time.
    assert.deepEqual(tunnel.pushTargets(), [
      { token: "phone-token", platform: "ios" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry already dirty with duplicate tokens rings each device once", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdot-notify-"));
  try {
    // Simulate a devices.json written by an older daemon: the same phone token
    // duplicated across three stale records, plus a second real device.
    const dup = (token) => ({
      addedAt: 1,
      lastSeenAt: 1,
      push: { token, platform: "ios", updatedAt: 1 },
    });
    writeFileSync(
      join(dir, "devices.json"),
      JSON.stringify({
        keyA: dup("phone-token"),
        keyB: dup("phone-token"),
        keyC: dup("phone-token"),
        keyD: dup("second-phone"),
      }),
    );
    const tunnel = new TunnelService(dir, "wss://relay.example/v1");

    // The duplicated token fans out exactly once; the distinct device too.
    assert.deepEqual(
      tunnel.pushTargets().map((t) => t.token).sort(),
      ["phone-token", "second-phone"],
    );

    // Foregrounding ANY record holding the duplicated token suppresses it,
    // even though two other (backgrounded) records still carry the same token.
    tunnel.setForeground("keyB", true);
    assert.deepEqual(tunnel.pushTargets(), [
      { token: "second-phone", platform: "ios" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
