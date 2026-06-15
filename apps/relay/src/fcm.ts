/**
 * The relay's one job beyond forwarding ciphertext: hand a device token + a
 * deliberately generic payload to Firebase Cloud Messaging.
 *
 * This is the sole place the relay holds a credential. It is configured from
 * the environment (a service-account JSON, the same way every other relay knob
 * is set) and lives only in memory — no token, payload, or device mapping is
 * ever written to disk. The daemon decides when to notify and which tokens to
 * target; here we just relay the push to Google and report back any tokens FCM
 * declared permanently dead so the daemon can prune them.
 *
 * Uses Node's built-in crypto for the RS256 service-account JWT and global
 * fetch for the HTTP calls, so the relay keeps its single runtime dependency
 * (ws). `fetch`/`now` are injectable for tests.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  /** Defaults to Google's standard OAuth2 token endpoint. */
  token_uri?: string;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_TTL_S = 3600;
/** Refresh a little early so a token never expires mid-request. */
const ACCESS_TOKEN_SKEW_S = 120;

type FetchFn = typeof fetch;

export interface FcmResult {
  /** Tokens FCM reported as permanently invalid (uninstalled / rotated). */
  dead: string[];
}

function base64Url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * FCM v1 errors that mean "this token is gone, stop sending to it": a 404 with
 * errorCode UNREGISTERED. We prune ONLY on this — a 400/payload error or a
 * transient 5xx must not evict a still-valid token.
 */
function isDeadToken(status: number, body: string): boolean {
  if (status === 404) return true;
  return /\bUNREGISTERED\b/.test(body);
}

/** The notification payload — generic by construction (no task content). */
function buildMessage(token: string, title: string, body: string): unknown {
  return {
    message: {
      token,
      notification: { title, body },
      apns: {
        headers: { "apns-priority": "10", "apns-push-type": "alert" },
        payload: { aps: { sound: "default" } },
      },
      android: { priority: "high", notification: { sound: "default" } },
    },
  };
}

export class FcmSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly deps: { fetch: FetchFn; now: () => number } = {
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
    },
  ) {}

  /**
   * Build a sender from the environment, or null when push isn't configured
   * (the common case — most self-hosters won't set up FCM). Reads the
   * service-account JSON inline from FCM_SERVICE_ACCOUNT_JSON or from the file
   * at FCM_SERVICE_ACCOUNT_FILE; FCM_PROJECT_ID overrides the JSON's project.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): FcmSender | null {
    const inline = env["FCM_SERVICE_ACCOUNT_JSON"]?.trim();
    const file = env["FCM_SERVICE_ACCOUNT_FILE"]?.trim();
    let raw: string | null = null;
    if (inline) {
      raw = inline;
    } else if (file) {
      try {
        raw = readFileSync(file, "utf8");
      } catch (err) {
        console.error(`relay: cannot read FCM_SERVICE_ACCOUNT_FILE (${file}): ${err}`);
        return null;
      }
    }
    if (!raw) return null;

    let parsed: Partial<ServiceAccount>;
    try {
      parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    } catch {
      console.error("relay: FCM service account is not valid JSON — push disabled");
      return null;
    }
    const projectId = env["FCM_PROJECT_ID"]?.trim() || parsed.project_id;
    if (!parsed.client_email || !parsed.private_key || !projectId) {
      console.error(
        "relay: FCM service account missing client_email/private_key/project_id — push disabled",
      );
      return null;
    }
    return new FcmSender({
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      project_id: projectId,
      ...(parsed.token_uri ? { token_uri: parsed.token_uri } : {}),
    });
  }

  /** The Firebase project these pushes are sent from (for startup logging). */
  get projectId(): string {
    return this.sa.project_id;
  }

  private async getAccessToken(): Promise<string> {
    const nowS = Math.floor(this.deps.now() / 1000);
    if (this.accessToken && this.accessToken.expiresAt > nowS + ACCESS_TOKEN_SKEW_S) {
      return this.accessToken.value;
    }
    const tokenUri = this.sa.token_uri ?? DEFAULT_TOKEN_URI;
    const signingInput =
      base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      base64Url(
        JSON.stringify({
          iss: this.sa.client_email,
          scope: FCM_SCOPE,
          aud: tokenUri,
          iat: nowS,
          exp: nowS + ACCESS_TOKEN_TTL_S,
        }),
      );
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const jwt = signingInput + "." + base64Url(signer.sign(this.sa.private_key));

    const res = await this.deps.fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`OAuth token endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("OAuth token endpoint returned no access_token");
    this.accessToken = {
      value: json.access_token,
      expiresAt: nowS + (json.expires_in ?? ACCESS_TOKEN_TTL_S),
    };
    return json.access_token;
  }

  /**
   * Send one notification to each token. Never throws for a single token's
   * failure — a bad token can't sink the batch; it returns in `dead` if FCM
   * says it's permanently gone. Throws only if auth itself fails (no token
   * could be delivered anyway).
   */
  async send(tokens: string[], title: string, body: string): Promise<FcmResult> {
    const accessToken = await this.getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`;
    const dead: string[] = [];
    await Promise.all(
      tokens.map(async (token) => {
        try {
          const res = await this.deps.fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(buildMessage(token, title, body)),
          });
          if (res.ok) return;
          const text = await res.text().catch(() => "");
          if (isDeadToken(res.status, text)) dead.push(token);
          else console.warn(`relay: FCM send failed (${res.status}): ${text.slice(0, 200)}`);
        } catch (err) {
          console.warn(`relay: FCM send error: ${err}`);
        }
      }),
    );
    return { dead };
  }
}
