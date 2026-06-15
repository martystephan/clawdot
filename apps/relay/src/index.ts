#!/usr/bin/env node
import { parseArgs } from "node:util";
import { FcmSender } from "./fcm.js";
import { startRelay } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env["PORT"] ?? "9700" },
    host: { type: "string", default: process.env["HOST"] ?? "127.0.0.1" },
    /** Serve the built web app from this directory (pairing QRs link to it). */
    static: { type: "string", default: process.env["STATIC_DIR"] },
  },
});

// A common mix-up: HOST is the interface the relay binds INSIDE the
// container (0.0.0.0), not the public domain. The relay never needs to know
// its domain — that lives in the reverse proxy (Dokploy's Domains tab,
// Caddy, ...). Fail fast with a real explanation instead of a DNS trace.
if (/[/:]/.test(values.host)) {
  console.error(
    `HOST must be a listen interface like 0.0.0.0, got "${values.host}".\n` +
      "Don't put your domain here — configure the domain in the reverse proxy " +
      "(e.g. Dokploy's Domains tab) and leave HOST at its default.",
  );
  process.exit(1);
}

/** Positive integer from the environment, or undefined for the built-in default. */
function envInt(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const maxPayloadMb = envInt("MAX_PAYLOAD_MB");

startRelay({
  port: Number(values.port),
  host: values.host,
  staticDir: values.static,
  maxPayloadBytes: maxPayloadMb ? maxPayloadMb * 1024 * 1024 : undefined,
  maxClientsPerRoom: envInt("MAX_CLIENTS_PER_ROOM"),
  maxRooms: envInt("MAX_ROOMS"),
  // Push is opt-in: with no FCM service account in the environment this is
  // null and push.send requests are ignored. See fcm.ts.
  fcm: FcmSender.fromEnv(),
});
