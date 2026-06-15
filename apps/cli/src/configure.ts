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
    } else {
      const value = await p.text({
        message: "Daemon port",
        initialValue: String(current.port ?? 8787),
        validate: validatePort,
      });
      bailIfCancelled(value);
      config.update({ port: Number(value) });
    }
    changed = true;
    p.log.success("Saved.");
  }

  p.outro(changed ? "Restart the daemon to apply the changes." : "Nothing changed.");
}
