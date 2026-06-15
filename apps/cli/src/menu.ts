/**
 * Bare `clawdot` — the interactive home screen. On the very first run (no
 * config.json yet) it opens with the setup wizard, then drops into a menu of
 * everything the CLI can do. Non-TTY invocations never land here: index.ts
 * prints the help screen instead so scripts and pipes keep working.
 */
import * as p from "@clack/prompts";
import { runConfig } from "./configure.js";
import { DaemonClient } from "./daemon-client.js";
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
      case "config":
        await runConfig(opts.dataDir);
        break;
      case "setup":
        await runSetup(opts.dataDir);
        break;
    }
  }
}
