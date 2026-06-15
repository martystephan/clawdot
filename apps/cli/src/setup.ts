/**
 * `clawdot setup` — guided first-run configuration. Everything it writes
 * lands in the data dir's config.json; flags and env vars still override at
 * runtime. Safe to re-run any time (current values are the defaults).
 */
import * as p from "@clack/prompts";
import {
  bailIfCancelled,
  relayReachable,
  requireTty,
  validatePort,
  validateRelayUrl,
} from "./cli-ui.js";
import { detectService, installService } from "./service.js";
import { ConfigStore } from "./store.js";

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

export async function runSetup(dataDir: string): Promise<void> {
  requireTty("setup");
  const config = new ConfigStore(dataDir);
  const current = config.get();

  p.intro("clawdot setup");
  p.log.message(
    "The daemon runs terminal sessions for coding agents on this machine;\n" +
      "your phone connects through a relay you host, end-to-end encrypted.\n" +
      `Answers are saved to ${config.path} — re-run this wizard whenever you like.`,
  );

  // -- Relay -------------------------------------------------------------------
  const relayAnswer = await p.text({
    message: "Relay endpoint for remote access (leave empty to skip)",
    placeholder: "wss://your-domain/v1",
    initialValue: current.relayUrl ?? "",
    validate: validateRelayUrl,
  });
  bailIfCancelled(relayAnswer);
  let relayUrl = relayAnswer.trim();

  if (relayUrl) {
    const s = p.spinner();
    s.start("Checking the relay");
    if (await relayReachable(relayUrl)) {
      s.stop("Relay is reachable");
    } else {
      s.error("Could not reach the relay's /healthz");
      const keep = await p.confirm({
        message: "Keep this endpoint anyway? (maybe it just isn't deployed yet)",
        initialValue: true,
      });
      bailIfCancelled(keep);
      if (!keep) relayUrl = "";
    }
  } else {
    p.log.info("Remote access stays off — add a relay later with `clawdot config`.");
  }

  // -- Port -----------------------------------------------------------------------
  const portAnswer = await p.text({
    message: "Daemon port (the web app expects 8787)",
    initialValue: String(current.port ?? 8787),
    validate: validatePort,
  });
  bailIfCancelled(portAnswer);

  const port = Number(portAnswer);
  config.update({
    relayUrl: relayUrl || undefined,
    port,
  });

  // -- Background service -----------------------------------------------------
  // The wizard knows the system: it offers the mechanism this platform
  // actually supports (launchd / systemd user unit / Windows Startup folder)
  // and explains itself when there is none (e.g. Linux without systemd).
  const platformName = PLATFORM_NAMES[process.platform] ?? process.platform;
  const support = detectService(dataDir);
  let serviceRunning = false;
  if (support.ok) {
    p.log.info(`This is ${platformName} — the daemon can run as a ${support.manager.summary}.`);
    const installAnswer = await p.confirm({
      message: support.manager.installed()
        ? "Update the background service now? (already installed — refreshes the definition)"
        : "Run the daemon in the background? (recommended — your phone can connect any time)",
      initialValue: true,
    });
    bailIfCancelled(installAnswer);
    if (installAnswer) {
      try {
        await installService(support.manager, { port });
        serviceRunning = true;
      } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        p.log.warn(
          "You can retry with `clawdot service install`, or run `clawdot serve` in a terminal.",
        );
      }
    }
  } else {
    p.log.warn(support.reason);
  }

  p.note(
    [
      ...(serviceRunning
        ? ["clawdot service            manage the background daemon"]
        : [
            "clawdot service install    run the daemon in the background",
            "clawdot serve              …or run it in this terminal",
          ]),
      relayUrl
        ? "clawdot pair               pair your phone (QR code)"
        : "clawdot config             add a relay when you have one",
      "clawdot devices            manage paired devices",
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Saved to ${config.path}`);
}
