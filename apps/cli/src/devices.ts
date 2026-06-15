/**
 * `clawdot devices` — list paired devices and revoke them. Talks to the
 * running daemon over the local socket (device management is a local-only
 * privilege, same as pairing).
 */
import * as p from "@clack/prompts";
import type { DeviceMeta } from "@clawdot/protocol";
import { bailIfCancelled, requireTty } from "./cli-ui.js";
import { DaemonClient } from "./daemon-client.js";

const shortKey = (key: string) => `${key.slice(0, 12)}…`;
const when = (ts: number) => new Date(ts).toLocaleString();

export async function runDevices(port: number): Promise<void> {
  requireTty("devices");
  p.intro("clawdot devices");

  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(port);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    for (;;) {
      const { devices } = await client.request({ type: "device.list" }, "device.list");
      if (devices.length === 0) {
        p.log.info("No paired devices. Run `clawdot pair` to add one.");
        break;
      }

      const choice = await p.select({
        message: `${devices.length} paired device${devices.length === 1 ? "" : "s"} — select one to revoke`,
        options: [
          ...devices.map((device: DeviceMeta) => ({
            value: device.key,
            label: shortKey(device.key),
            hint: `paired ${when(device.addedAt)} · last seen ${when(device.lastSeenAt)}`,
          })),
          { value: "__done", label: "Done" },
        ],
      });
      bailIfCancelled(choice);
      if (choice === "__done") break;

      const confirmed = await p.confirm({
        message: `Revoke ${shortKey(choice)}? It will have to pair again (an already-open connection lasts until it drops).`,
        initialValue: false,
      });
      bailIfCancelled(confirmed);
      if (confirmed) {
        await client.request({ type: "device.revoke", key: choice }, "device.list");
        p.log.success("Revoked.");
      }
    }
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    client.close();
  }
  p.outro("Done.");
}
