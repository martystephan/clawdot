#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@clawdot/protocol";
import { runConfig } from "./configure.js";
import { runDevices } from "./devices.js";
import { runMenu } from "./menu.js";
import { runPair } from "./pair.js";
import { runService } from "./service.js";
import { runSetup } from "./setup.js";
import { startServer } from "./server.js";
import { ConfigStore } from "./store.js";

const HELP = `clawdot — run coding agents on your machine, drive them from your phone

Usage
  clawdot              interactive menu (setup wizard on the first run)
  clawdot serve        start the daemon in this terminal
  clawdot service      run the daemon as a background service
                       (install | update | uninstall | restart | status)
  clawdot setup        guided configuration wizard
  clawdot config       view & edit saved settings
  clawdot pair         pair a phone (QR code / pairing code)
  clawdot devices      list & revoke paired devices
  clawdot help         this screen

Options
  --port <n>           daemon port                 (saved port or 8787)
  --cwd <dir>          default working directory   (current directory)
  --data-dir <dir>     data directory              ($CLAWDOT_DATA_DIR or ~/.clawdot)
  --relay <url>        relay endpoint — remembered (--relay "" forgets it)
  --no-relay           disable remote access for this run
  -h, --help           this screen

First time? Just run \`clawdot\` — the wizard starts automatically.

Configuration precedence: flags > environment (CLAWDOT_RELAY, CLAWDOT_DATA_DIR)
> config.json in the data dir (written by setup/config/--relay).
There is no default relay — you point clawdot at the one you host (see the
root Dockerfile).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    "data-dir": { type: "string" },
    relay: { type: "string" },
    "no-relay": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

// No command opens the interactive menu (setup wizard on the first run);
// non-TTY invocations get the help screen so scripts and pipes keep working.
const command = positionals[0];
const dataDir = resolve(
  values["data-dir"] ?? process.env["CLAWDOT_DATA_DIR"] ?? join(homedir(), ".clawdot"),
);

if (
  values.help ||
  command === "help" ||
  (command === undefined && !(process.stdin.isTTY && process.stdout.isTTY))
) {
  console.log(HELP);
  process.exit(0);
}

const config = new ConfigStore(dataDir);
// Flag > saved port > well-known default (the web app expects 8787).
const port = Number(values.port ?? config.get().port ?? 8787);

/**
 * Re-reads the config: the menu's setup/settings flows may have changed the
 * saved port or relay since startup.
 */
function startDaemon(): void {
  const config = new ConfigStore(dataDir);
  // Relay resolution — there is deliberately NO built-in default; everyone
  // points at their own relay. `--relay <url>` is remembered in the data
  // dir (`--relay ""` forgets it); CLAWDOT_RELAY and --no-relay are per run.
  let relayUrl: string | null;
  if (values["no-relay"]) {
    relayUrl = null;
  } else if (values.relay !== undefined) {
    relayUrl = values.relay || null;
    config.relayUrl = relayUrl;
  } else {
    relayUrl = process.env["CLAWDOT_RELAY"] || config.relayUrl;
  }

  console.log(`Clawdot daemon — protocol v${PROTOCOL_VERSION}`);
  if (!config.existed) {
    console.log("tip: bare `clawdot` walks you through guided configuration");
  }
  startServer({
    port: Number(values.port ?? config.get().port ?? 8787),
    cwd: resolve(values.cwd),
    dataDir,
    relayUrl,
  });
}

switch (command) {
  case undefined: {
    const action = await runMenu({ dataDir, portFlag: values.port });
    if (action === "serve") startDaemon();
    break;
  }
  case "serve":
    startDaemon();
    break;
  case "setup":
    await runSetup(dataDir);
    break;
  case "config":
    await runConfig(dataDir);
    break;
  case "pair":
    await runPair(port);
    break;
  case "devices":
    await runDevices(port);
    break;
  case "service":
    await runService(positionals[1], { dataDir, port });
    break;
  default:
    console.error(`unknown command: ${command}\n`);
    console.error(HELP);
    process.exit(1);
}
