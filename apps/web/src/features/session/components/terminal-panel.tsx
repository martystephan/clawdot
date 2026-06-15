import { Terminal, X } from "lucide-react";
import { Button, ResizeHandle, usePanelWidth } from "@/components/ui";
import { XtermSurface } from "@/features/session/components/xterm-surface";
import type { TerminalApi } from "@/features/session/hooks/use-daemon";

/**
 * Right-side companion shell: a persistent terminal bound to the selected
 * session. Unlike an agent session it stays hidden from the sidebar, but it
 * lives daemon-side just the same — this panel only ever ATTACHES, so closing
 * it (which unmounts the surface and detaches) leaves the shell running in the
 * background, and switching back reattaches and replays the scrollback.
 *
 * Spawning is the caller's job (app.tsx, from a click handler): a persistent
 * open isn't idempotent and StrictMode double-invokes effects, so opening from
 * inside the surface would spawn two shells. Here `companionId` is null only
 * while a shell is starting or after one exited.
 */
export function TerminalPanel({
  connected,
  companionId,
  spawning,
  terminal,
  onStart,
  onClose,
}: {
  connected: boolean;
  /** The session's live background shell, or null while starting / once exited. */
  companionId: string | null;
  /** A spawn is in flight — show "starting" rather than the start button. */
  spawning: boolean;
  terminal: TerminalApi;
  /** Spawn (or respawn) this session's background shell. */
  onStart: () => void;
  onClose: () => void;
}) {
  // Shared with the preview panel — they occupy the same edge, one at a time.
  const { width, resize } = usePanelWidth({
    key: "clawdot.panel.width",
    fallback: 384,
    min: 264,
    max: 800,
  });

  return (
    <aside
      style={{ "--panel-w": `${width}px` } as React.CSSProperties}
      className="mobile-takeover relative flex w-[min(var(--panel-w),70vw)] shrink-0 flex-col border-l border-border bg-app"
    >
      <div className="flex min-h-10.5 items-center gap-2.25 border-b border-border px-3 py-2.25">
        <Terminal size={14} className="text-fg-mid" />
        <span className="font-[550]">Terminal</span>
        <span className="flex-1" />
        <Button
          size="icon"
          title="Close terminal"
          aria-label="Close terminal"
          onClick={onClose}
        >
          <X size={13} />
        </Button>
      </div>
      {companionId ? (
        // Keyed by the shell's id so a respawn (new id) remounts cleanly onto
        // the new shell instead of reattaching the surface to the old one.
        <XtermSurface
          key={companionId}
          connected={connected}
          start={(size, events) =>
            terminal.attach(companionId, size.cols, size.rows, events)
          }
          // Detach, not close: the shell lives on in the background.
          stop={(id) => terminal.detach(id)}
          terminal={terminal}
          exitedLabel={(code) =>
            code === null
              ? "Shell ended — connection lost"
              : `Shell exited (code ${code})`
          }
          exitedAction={{ label: "Restart shell", onAction: onStart }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
          {spawning ? (
            <span className="text-[12.5px] text-fg-mid">Starting shell…</span>
          ) : (
            <>
              <span className="text-[12.5px] text-fg-mid">No shell running.</span>
              <Button onClick={onStart}>Start shell</Button>
            </>
          )}
        </div>
      )}
      <ResizeHandle
        edge="left"
        width={width}
        onResize={resize}
        label="Resize terminal panel"
      />
    </aside>
  );
}
