import { XtermSurface } from "@/features/session/components/xterm-surface";
import type { TerminalApi } from "@/features/session/hooks/use-daemon";

/**
 * Main-area view of a persistent terminal session (an agent like claude or
 * codex running in a daemon-side PTY). Mounting attaches — which replays the
 * scrollback — and unmounting only detaches: the agent keeps running when
 * the user switches sessions or locks their phone. Key this component by
 * terminalId so switching terminals remounts cleanly.
 */
export function TerminalSessionView({
  connected,
  terminalId,
  terminal,
  onDismiss,
}: {
  connected: boolean;
  terminalId: string;
  terminal: TerminalApi;
  /** The terminal ended and the user acknowledged it — deselect the view. */
  onDismiss: () => void;
}) {
  return (
    <XtermSurface
      connected={connected}
      start={(size, events, opts) =>
        terminal.attach(terminalId, size.cols, size.rows, events, opts?.takeover)
      }
      stop={(id) => terminal.detach(id)}
      terminal={terminal}
      exitedLabel={(code) =>
        code === null
          ? "This terminal is gone"
          : `Process exited (code ${code})`
      }
      exitedAction={{ label: "Close", onAction: onDismiss }}
    />
  );
}
