// Unit tests for the relay's FCM sender. Injects fetch + a clock, so no real
// Google call happens. Runs against src/ via tsx:
//   tsx --test test/fcm.test.mjs   (part of `pnpm --filter @clawdot/relay test`)
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { FcmSender } from "../src/fcm.ts";

// A real RSA key so the RS256 JWT actually signs (we never verify it here).
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  client_email: "svc@clawdot.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "clawdot-test",
};

function makeRes(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body,
  };
}

/** A fetch stub: token endpoint returns an access token; send uses `sendFor`. */
function stubFetch(sendFor) {
  const calls = { token: 0, send: 0 };
  const fetch = async (url, _init) => {
    if (String(url).includes("oauth2")) {
      calls.token++;
      return makeRes(200, JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
    }
    calls.send++;
    return sendFor(_init);
  };
  return { fetch, calls };
}

const fixedNow = () => 1_700_000_000_000;

test("delivers to every token and reports none dead on success", async () => {
  const { fetch, calls } = stubFetch(() => makeRes(200, "{}"));
  const sender = new FcmSender(serviceAccount, { fetch, now: fixedNow });
  const result = await sender.send(["t1", "t2", "t3"], "Clawdot", "x needs you");
  assert.deepEqual(result.dead, []);
  assert.equal(calls.send, 3);
});

test("flags a 404 / UNREGISTERED token as dead, keeps others", async () => {
  const { fetch } = stubFetch((init) => {
    const body = JSON.parse(init.body);
    if (body.message.token === "dead404") return makeRes(404, "Requested entity was not found.");
    if (body.message.token === "deadUnreg")
      return makeRes(400, JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }));
    return makeRes(200, "{}");
  });
  const sender = new FcmSender(serviceAccount, { fetch, now: fixedNow });
  const result = await sender.send(["good", "dead404", "deadUnreg"], "t", "b");
  assert.deepEqual(result.dead.sort(), ["dead404", "deadUnreg"]);
});

test("does NOT prune on a transient/payload error (400 without UNREGISTERED)", async () => {
  const { fetch } = stubFetch(() => makeRes(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT" } })));
  const sender = new FcmSender(serviceAccount, { fetch, now: fixedNow });
  const result = await sender.send(["maybe-good"], "t", "b");
  assert.deepEqual(result.dead, []);
});

test("caches the access token across sends", async () => {
  const { fetch, calls } = stubFetch(() => makeRes(200, "{}"));
  const sender = new FcmSender(serviceAccount, { fetch, now: fixedNow });
  await sender.send(["a"], "t", "b");
  await sender.send(["b"], "t", "b");
  assert.equal(calls.token, 1, "token endpoint should be hit once, then cached");
  assert.equal(calls.send, 2);
});

test("fromEnv returns null when unconfigured, builds when given JSON", () => {
  assert.equal(FcmSender.fromEnv({}), null);
  const sender = FcmSender.fromEnv({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount) });
  assert.ok(sender);
  assert.equal(sender.projectId, "clawdot-test");
  // FCM_PROJECT_ID overrides
  const overridden = FcmSender.fromEnv({
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
    FCM_PROJECT_ID: "other-project",
  });
  assert.equal(overridden.projectId, "other-project");
});
