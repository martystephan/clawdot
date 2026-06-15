/**
 * `clawdot config` — view and edit the saved settings, one at a time.
 * The menu shows current values inline; changes apply on the daemon's next
 * start.
 */
import * as p from "@clack/prompts";
import {
  bailIfCancelled,
  relayReachable,
  requireTty,
  validatePort,
  validateRelayUrl,
} from "./cli-ui.js";
import { ConfigStore } from "./store.js";

export async function runConfig(dataDir: string): Promise<void> {
  requireTty("config");
  const config = new ConfigStore(dataDir);
  p.intro("clawdot config");

  let changed = false;
  for (;;) {
    const current = config.get();
    const field = await p.select({
      message: `Settings (${config.path})`,
      options: [
        {
          value: "relayUrl",
          label: "Relay endpoint",
          hint: current.relayUrl ?? "not set — remote access off",
        },
        {
          value: "port",
          label: "Daemon port",
          hint: String(current.port ?? 8787),
        },
        {
          value: "unlimitedPairing",
          label: "Unlimited pairing token",
          hint: current.unlimitedPairing
            ? "on — token never expires, pairs unlimited devices"
            : "off — 10-minute, one-device window",
        },
        { value: "done", label: "Done" },
      ],
    });
    bailIfCancelled(field);
    if (field === "done") break;

    if (field === "relayUrl") {
      const value = await p.text({
        message: "Relay endpoint (empty turns remote access off)",
        placeholder: "wss://your-domain/v1",
        initialValue: current.relayUrl ?? "",
        validate: validateRelayUrl,
      });
      bailIfCancelled(value);
      const relayUrl = value.trim();
      if (relayUrl && !(await relayReachable(relayUrl))) {
        p.log.warn("Could not reach that relay's /healthz — saved anyway.");
      }
      config.update({ relayUrl: relayUrl || undefined });
    } else if (field === "port") {
      const value = await p.text({
        message: "Daemon port",
        initialValue: String(current.port ?? 8787),
        validate: validatePort,
      });
      bailIfCancelled(value);
      config.update({ port: Number(value) });
    } else {
      const value = await p.confirm({
        message: "Make the pairing token never expire and pair unlimited devices?",
        initialValue: current.unlimitedPairing ?? false,
      });
      bailIfCancelled(value);
      if (value) {
        p.log.warn(
          "Anyone with the token can pair until you turn this off. Use it for trusted reviewers, then disable it.",
        );
      }
      config.update({ unlimitedPairing: value || undefined });
    }
    changed = true;
    p.log.success("Saved.");
  }

  p.outro(changed ? "Restart the daemon to apply the changes." : "Nothing changed.");
}
