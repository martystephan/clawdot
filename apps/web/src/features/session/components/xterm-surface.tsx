import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui";
import {
  applyKeyMods,
  KeyBar,
  NO_MODS,
  type KeyMods,
} from "@/features/session/components/key-bar";
import type {
  TerminalApi,
  TerminalEvents,
} from "@/features/session/hooks/use-daemon";
import { KEYBOARD_MIN_PX, useKeyboardInset } from "@/lib/keyboard-inset";

/** xterm theme from the app's design tokens (they vary with data-theme). */
function xtermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--bg-inset"),
    foreground: token("--fg"),
    cursor: token("--fg"),
    cursorAccent: token("--bg-inset"),
    selectionBackground: token("--bg-active"),
    // Without an explicit ANSI palette xterm falls back to its built-in
    // dark-background defaults, which are unreadable on the light theme.
    black: token("--term-black"),
    red: token("--term-red"),
    green: token("--term-green"),
    yellow: token("--term-yellow"),
    blue: token("--term-blue"),
    magenta: token("--term-magenta"),
    cyan: token("--term-cyan"),
    white: token("--term-white"),
    brightBlack: token("--term-bright-black"),
    brightRed: token("--term-bright-red"),
    brightGreen: token("--term-bright-green"),
    brightYellow: token("--term-bright-yellow"),
    brightBlue: token("--term-bright-blue"),
    brightMagenta: token("--term-bright-magenta"),
    brightCyan: token("--term-bright-cyan"),
    brightWhite: token("--term-bright-white"),
  };
}

/**
 * The xterm.js host shared by every terminal view. Owns the full lifecycle:
 * mounts an xterm, calls `start` (terminal.open or terminal.attach) with the
 * fitted size, plumbs keystrokes/resizes, and calls `stop` (close or detach)
 * on unmount. A dropped connection tears the xterm down and `start`s again
 * on reconnect — for persistent terminals that reattach replays the
 * scrollback, for ephemeral ones it spawns a fresh shell.
 */
export function XtermSurface({
  connected,
  epoch = 0,
  start,
  stop,
  terminal,
  exitedLabel,
  exitedAction,
}: {
  connected: boolean;
  /** Bump to tear down and `start` again (e.g. a restart action). */
  epoch?: number;
  /** Initiate the daemon-side terminal for a freshly mounted xterm. */
  start: (
    size: { cols: number; rows: number },
    events: TerminalEvents,
    opts?: { takeover?: boolean },
  ) => void;
  /** Release the terminal when the view goes away. */
  stop: (terminalId: string) => void;
  terminal: TerminalApi;
  /** Overlay text once the terminal ended; null code = connection/terminal lost. */
  exitedLabel: (exitCode: number | null) => string;
  exitedAction?: { label: string; onAction: () => void };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // false = running (or starting); a number/null is the exit code.
  const [exited, setExited] = useState<number | null | false>(false);
  // Another connection is viewing this terminal (attach refused or kicked).
  const [busy, setBusy] = useState(false);
  // Set by the effect that owns the xterm; the busy overlay's button
  // re-attaches into that same xterm with takeover.
  const takeOverRef = useRef<() => void>(() => {});
  // The callbacks close over parent render state — keep the effect off their
  // identity so a parent re-render never tears the terminal down.
  const callbacksRef = useRef({ start, stop });
  callbacksRef.current = { start, stop };
  // On-screen-keyboard helper bar: one-shot ctrl/shift armed from the bar
  // apply to the next key (bar tap or typed), mirrored into a ref so the
  // xterm onData handler inside the effect sees the current value.
  const keyboardInset = useKeyboardInset();
  const [mods, setMods] = useState<KeyMods>(NO_MODS);
  const modsRef = useRef(mods);
  modsRef.current = mods;
  // Set by the effect; lets the key bar inject input into the live terminal.
  const sendKeyRef = useRef<(data: string) => void>(() => {});

  useEffect(() => {
    const el = containerRef.current;
    if (!connected || !el) return;
    setExited(false);
    setBusy(false);

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      theme: xtermTheme(),
      scrollback: 5000,
      allowProposedApi: true, // the unicode11 addon needs the unicode API
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon());
    // Unicode 11 widths (emoji, CJK) — must match the daemon's headless
    // xterm, which serializes reattach snapshots with the same width tables.
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = "11";
    xterm.open(el);
    fit.fit();

    let terminalId: string | null = null;
    let disposed = false;
    const events: TerminalEvents = {
      onOpened: (id) => {
        // The view may have unmounted while the request was in flight.
        if (disposed) {
          callbacksRef.current.stop(id);
          return;
        }
        terminalId = id;
        setBusy(false);
        // Start from a blank screen: an attach ack is always followed by a
        // snapshot replay, and this view may receive more than one (React
        // re-runs effects on Suspense reveals / StrictMode, so two attaches
        // can race into the same surviving xterm). The clear must go
        // through the write queue — xterm.reset() is synchronous and would
        // run before queued data from an earlier replay is even parsed.
        xterm.write("\x1b[H\x1b[2J\x1b[3J"); // home + clear screen + clear scrollback
        // The fit may have changed dimensions since the request was sent.
        terminal.resize(id, xterm.cols, xterm.rows);
        xterm.focus();
      },
      onData: (data) => xterm.write(data),
      onExit: (code) => {
        terminalId = null;
        if (!disposed) setExited(code);
      },
      onError: (message) => {
        xterm.writeln(`\x1b[31m${message}\x1b[0m`);
        if (terminalId === null && !disposed) setExited(null);
      },
      onBusy: () => {
        terminalId = null; // we are no longer the viewer — stop sending input
        if (!disposed) setBusy(true);
      },
    };
    callbacksRef.current.start({ cols: xterm.cols, rows: xterm.rows }, events);
    // Re-attach into the same xterm with takeover; the snapshot replay that
    // follows onOpened repaints the screen from scratch.
    takeOverRef.current = () => {
      if (disposed) return;
      setBusy(false);
      callbacksRef.current.start({ cols: xterm.cols, rows: xterm.rows }, events, {
        takeover: true,
      });
    };

    sendKeyRef.current = (data) => {
      if (terminalId) terminal.input(terminalId, data);
    };
    const inputSub = xterm.onData((data) => {
      if (!terminalId) return;
      const armed = modsRef.current;
      terminal.input(terminalId, applyKeyMods(data, armed));
      if (armed.ctrl || armed.shift) setMods(NO_MODS);
    });
    const resizeSub = xterm.onResize(({ cols, rows }) => {
      if (terminalId) terminal.resize(terminalId, cols, rows);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    // xterm only scrolls on wheel events — translate vertical touch drags
    // into scrollback scrolling, or into arrow keys when a TUI owns the
    // alternate screen (no scrollback there; this mirrors terminals'
    // "alternate scroll" wheel mode). Consuming the move also keeps iOS
    // from panning the page instead.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null) return;
      e.preventDefault();
      const y = e.touches[0]?.clientY ?? touchY;
      const cell = Math.max(8, el.clientHeight / xterm.rows);
      const lines = Math.trunc((y - touchY) / cell);
      if (lines === 0) return;
      touchY += lines * cell;
      if (xterm.buffer.active.type === "alternate") {
        // Drag down = look further up.
        const prefix = xterm.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
        const arrow = prefix + (lines > 0 ? "A" : "B");
        if (terminalId) {
          terminal.input(terminalId, arrow.repeat(Math.abs(lines)));
        }
      } else {
        xterm.scrollLines(-lines);
      }
    };
    const onTouchEnd = () => {
      touchY = null;
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    // The theme toggle only flips data-theme on <html>; xterm can't consume
    // CSS variables itself, so re-resolve the tokens into the live instance.
    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      disposed = true;
      observer.disconnect();
      themeObserver.disconnect();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      inputSub.dispose();
      resizeSub.dispose();
      if (terminalId) callbacksRef.current.stop(terminalId);
      xterm.dispose();
    };
  }, [connected, epoch, terminal]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 bg-inset">
        <div ref={containerRef} className="absolute inset-0 p-2 pr-0" />
        {connected && exited !== false && (
          <div className="absolute inset-0 z-1 flex flex-col items-center justify-center gap-2.5 bg-black/35">
            <span className="text-fg-mid">{exitedLabel(exited)}</span>
            {exitedAction && (
              <Button onClick={exitedAction.onAction}>
                {exitedAction.label}
              </Button>
            )}
          </div>
        )}
        {connected && exited === false && busy && (
          <div className="absolute inset-0 z-1 flex flex-col items-center justify-center gap-2.5 bg-black/35">
            <span className="text-fg-mid">
              This session is open on another device
            </span>
            <Button onClick={() => takeOverRef.current()}>
              Take over here
            </Button>
          </div>
        )}
        {!connected && (
          <div className="absolute inset-0 z-1 flex items-center justify-center bg-black/35 text-fg-mid">
            Waiting for connection…
          </div>
        )}
      </div>
      {keyboardInset > KEYBOARD_MIN_PX && (
        <KeyBar
          mods={mods}
          onModsChange={setMods}
          onKey={(data) => {
            sendKeyRef.current(data);
            if (mods.ctrl || mods.shift) setMods(NO_MODS);
          }}
        />
      )}
    </div>
  );
}
