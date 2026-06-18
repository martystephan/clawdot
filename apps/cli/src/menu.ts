/**
 * Bare `clawdot` — the interactive home screen. On the very first run (no
 * config.json yet) it opens with the setup wizard, then drops into a menu of
 * everything the CLI can do. Non-TTY invocations never land here: index.ts
 * prints the help screen instead so scripts and pipes keep working.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { runConfig } from "./configure.js";
import { DaemonClient, describeRelay, fetchRelayStatus } from "./daemon-client.js";
import { runDevices } from "./devices.js";
import { runPair } from "./pair.js";
import { runService } from "./service.js";
import { runSetup } from "./setup.js";
import { ConfigStore } from "./store.js";

/** Quick local probe — connection refused fails fast on localhost. */
async function daemonAnswering(port: number): Promise<boolean> {
  try {
    (await DaemonClient.connect(port)).close();
    return true;
  } catch {
    return false;
  }
}

/** Print the tail of the background-service log, or explain where it lives. */
function showLogs(dataDir: string): void {
  const path = join(dataDir, "logs", "daemon.log");
  if (!existsSync(path)) {
    p.log.warn(
      `No log file at ${path} yet. The background service writes there; ` +
        "`clawdot serve` logs to this terminal instead.",
    );
    return;
  }
  const tail = readFileSync(path, "utf8").split("\n").slice(-40).join("\n").trim();
  p.log.info(`Last lines of ${path}:\n\n${tail || "(empty)"}`);
}

/**
 * Loops until the user quits or picks "start the daemon here" — serve stays
 * in index.ts (it owns relay/flag resolution), the menu only dispatches.
 */
export async function runMenu(opts: {
  dataDir: string;
  /** The --port flag, which still outranks the saved port. */
  portFlag?: string;
}): Promise<"serve" | "quit"> {
  if (!new ConfigStore(opts.dataDir).existed) {
    await runSetup(opts.dataDir);
  }

  p.intro("clawdot — coding agents on your machine, driven from your phone");
  for (;;) {
    // Re-read every round: setup/settings may have just changed the port.
    const config = new ConfigStore(opts.dataDir);
    const current = config.get();
    const port = Number(opts.portFlag ?? current.port ?? 8787);
    const up = await daemonAnswering(port);

    // Error indicator: when the daemon is up but its relay link is down,
    // remote pairing silently fails — surface why right here in the menu.
    if (up) {
      const relay = describeRelay(await fetchRelayStatus(port));
      if (!relay.ok) p.log.warn(`Relay: ${relay.text} — phone pairing won't work until this connects.`);
    }

    const choice = await p.select({
      message: up
        ? `Daemon is answering on ws://localhost:${port} — what next?`
        : `No daemon on ws://localhost:${port} — what next?`,
      options: [
        ...(up
          ? []
          : [
              {
                value: "serve",
                label: "Start the daemon here",
                hint: "runs in this terminal until you stop it",
              },
            ]),
        {
          value: "service",
          label: "Background service",
          hint: "install · restart · status · uninstall",
        },
        {
          value: "pair",
          label: "Pair a phone",
          hint: current.relayUrl
            ? "QR code / pairing code"
            : "needs a relay — set one in settings first",
        },
        { value: "devices", label: "Paired devices", hint: "list · revoke" },
        { value: "logs", label: "View daemon logs", hint: "recent output incl. relay errors" },
        { value: "config", label: "Settings", hint: config.path },
        { value: "setup", label: "Setup wizard", hint: "re-run the guided configuration" },
        { value: "quit", label: "Quit" },
      ],
    });
    if (p.isCancel(choice) || choice === "quit") {
      p.outro("Bye!");
      return "quit";
    }

    switch (choice) {
      case "serve":
        return "serve";
      case "service":
        await runService(undefined, { dataDir: opts.dataDir, port });
        break;
      case "pair":
        await runPair(port);
        break;
      case "devices":
        await runDevices(port);
        break;
      case "logs":
        showLogs(opts.dataDir);
        break;
      case "config":
        await runConfig(opts.dataDir);
        break;
      case "setup":
        await runSetup(opts.dataDir);
        break;
    }
  }
}
