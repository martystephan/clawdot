/**
 * Turns "an agent needs attention" into a push the relay can emit.
 *
 * The daemon is the only party that holds plaintext, so it decides when to
 * notify and to which device tokens. The payload it builds is deliberately
 * generic — the relay sees it on its way to FCM, so it names the session at
 * most and never reveals task content.
 */
import type { TerminalMeta } from "@clawdot/protocol";
import type { DaemonRelayControl } from "@clawdot/protocol/tunnel";
import type { TunnelService } from "./tunnel.js";

/**
 * The notification text. Names the session (its window title) but nothing
 * about what the agent is doing — keep it that way so a compromised relay
 * learns only that *some* session wants attention.
 */
export function attentionPayload(meta: { title: string }): { title: string; body: string } {
  const name = meta.title.trim() || "Agent";
  return { title: "Clawdot", body: `${name} needs your attention` };
}

export class PushNotifier {
  constructor(
    private readonly deps: {
      tunnel: TunnelService;
      /** Hands a push request to the relay (RelayLink.sendControl). */
      send: (msg: DaemonRelayControl) => void;
      /** Live read of the notifyOnBell setting. */
      enabled: () => boolean;
    },
  ) {}

  /** Push to every registered device, unless the feature is off or none exist. */
  notify(meta: TerminalMeta): void {
    if (!this.deps.enabled()) return;
    const tokens = this.deps.tunnel.pushTargets().map((target) => target.token);
    if (tokens.length === 0) return;
    const { title, body } = attentionPayload(meta);
    this.deps.send({ type: "push.send", tokens, title, body });
  }
}
