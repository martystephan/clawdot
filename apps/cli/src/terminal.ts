/**
 * Interactive terminals (PTYs) on the daemon's machine.
 *
 * Two lifetimes (see the protocol header for the contract):
 * - Ephemeral: owned by one connection; server.ts kills them when it drops,
 *   so a dead phone never leaves orphaned shells behind.
 * - Persistent (TerminalRegistry): daemon-scoped terminal sessions running a
 *   configured agent command. They survive disconnects, keep a bounded
 *   scrollback for reattach replay, and die only on terminal.close, process
 *   exit, or daemon shutdown (a PTY cannot be rehydrated from disk).
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { spawn } from "@lydell/node-pty";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalMeta } from "@clawdot/protocol";

// Both xterm packages are webpack UMD bundles: their named exports exist in
// the type declarations but not as ESM named exports at runtime, so a static
// `import { Terminal }` crashes on load. Require them instead.
const require = createRequire(import.meta.url);
const { Terminal: XtermHeadless } =
  require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon: XtermSerializeAddon } =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
const { Unicode11Addon: XtermUnicode11Addon } =
  require("@xterm/addon-unicode11") as typeof import("@xterm/addon-unicode11");

/** Lines of history kept per persistent terminal for reattach replay. */
const SCROLLBACK_LINES = 5000;

/**
 * Don't fire more than one attention notification per terminal within this
 * window. Agents can ring the bell several times in a burst (a finished turn
 * plus follow-up prompts); one buzz is enough.
 */
const ATTENTION_DEBOUNCE_MS = 10_000;

/** ASCII BEL — what agents (claude, codex) emit when a turn needs the user. */
const BEL = "\x07";

export interface TerminalHandle {
  id: string;
  /** The directory the shell actually started in (after fallback). */
  cwd: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** PTY dimensions a misbehaving client can't hurt us with. */
function clampSize(n: number): number {
  return Math.min(500, Math.max(2, Math.round(n)));
}

export function openTerminal(opts: {
  cwd?: string | undefined;
  cols: number;
  rows: number;
  /** Run this inside the user's shell instead of an interactive shell. */
  command?: string | undefined;
  onData(data: string): void;
  onExit(exitCode: number): void;
}): TerminalHandle {
  // A stale workspace path shouldn't kill the terminal — fall back to home.
  const cwd = opts.cwd && isDirectory(opts.cwd) ? opts.cwd : homedir();
  const shell =
    process.env.SHELL ||
    (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  // Login + interactive shell: a service-managed daemon starts with a
  // minimal environment, and the user's PATH lives in their profile/rc files
  // (incl. version managers like nvm that only touch the interactive rc) —
  // agent commands like `claude` must resolve exactly like in their own
  // terminal. Commands run inside that same shell via -c.
  const args =
    process.platform === "win32"
      ? opts.command
        ? ["-Command", opts.command]
        : []
      : opts.command
        ? ["-l", "-i", "-c", opts.command]
        : ["-l"];
  const env: Record<string, string> = { COLORTERM: "truecolor" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cwd,
    cols: clampSize(opts.cols),
    rows: clampSize(opts.rows),
    env,
  });
  pty.onData(opts.onData);
  pty.onExit(({ exitCode }) => opts.onExit(exitCode));
  return {
    id: randomUUID(),
    cwd,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(clampSize(cols), clampSize(rows)),
    kill: () => pty.kill(),
  };
}

export interface TerminalSubscriber {
  onData(data: string): void;
  onExit(exitCode: number): void;
  /** Another connection attached with takeover — this one stopped viewing. */
  onTakenOver(): void;
  /**
   * Whether the viewing client is in the foreground. A backgrounded viewer
   * isn't watching, so a bell should still notify. Absent → treated as
   * foreground (legacy/ephemeral subscribers that never report it).
   */
  isForeground?(): boolean;
}

interface PersistentTerminal {
  meta: TerminalMeta;
  handle: TerminalHandle;
  /**
   * Server-side screen model. Raw PTY output is full of in-place redraws and
   * cursor movement relative to a past width — replaying the byte log into a
   * fresh client xterm renders them as duplicated lines. So the daemon feeds
   * everything through a headless terminal and reattaching clients get a
   * serialized snapshot of the *current* screen + scrollback instead (the
   * same approach VS Code uses for reconnectable terminals).
   */
  screen: HeadlessTerminal;
  serializer: SerializeAddon;
  /**
   * The single connection currently viewing this terminal. One viewer at a
   * time: concurrent viewers would fight over the PTY size (every reattach
   * resizes), so a second device must explicitly take the view over.
   */
  viewer: TerminalSubscriber | null;
  /** Last time this terminal fired an attention notification (debounce). */
  lastAttentionAt: number;
  /**
   * Set once the user kills this terminal. A dying agent often emits a bell in
   * its teardown output; without this guard that final bell would trip the
   * attention path and fire a spurious notification for a session the user just
   * deliberately closed.
   */
  closing: boolean;
}

/** Daemon-scoped terminal sessions: spawn, subscribe, list, kill. */
export class TerminalRegistry {
  private readonly terminals = new Map<string, PersistentTerminal>();
  private readonly catalogListeners = new Set<() => void>();
  private readonly attentionListeners = new Set<(meta: TerminalMeta) => void>();

  /** Fired when a terminal is opened or exits (kill included). */
  onCatalogChange(fn: () => void): void {
    this.catalogListeners.add(fn);
  }

  /**
   * Fired when an unwatched terminal rings the bell — the signal that an agent
   * finished a turn or wants input while nobody is looking. Debounced per
   * terminal; stays quiet while a *foregrounded* viewer is attached (don't buzz
   * the device you're actively using), but a backgrounded viewer still fires.
   * server.ts turns this into a push.
   */
  onAttentionNeeded(fn: (meta: TerminalMeta) => void): void {
    this.attentionListeners.add(fn);
  }

  open(opts: {
    cwd?: string | undefined;
    cols: number;
    rows: number;
    command?: string | undefined;
    title: string;
    now: number;
  }): TerminalMeta {
    const screen = new XtermHeadless({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true, // the serialize addon needs the buffer API
    });
    const serializer = new XtermSerializeAddon();
    screen.loadAddon(serializer);
    // Unicode 11 widths — must match the client xterm (which also activates
    // 11) or serialized snapshots lay out emoji/CJK differently than the
    // live tail.
    screen.loadAddon(new XtermUnicode11Addon());
    screen.unicode.activeVersion = "11";
    const term: PersistentTerminal = {
      // placeholder, replaced right below once the handle exists
      meta: {
        terminalId: "",
        title: opts.title,
        cwd: "",
        createdAt: opts.now,
        needsAttention: false,
      },
      handle: null as unknown as TerminalHandle,
      screen,
      serializer,
      viewer: null,
      lastAttentionAt: 0,
      closing: false,
    };
    screen.onTitleChange((title) => {
      if (title && title !== term.meta.title) {
        term.meta = { ...term.meta, title };
        this.notifyCatalog();
      }
    });
    term.handle = openTerminal({
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      command: opts.command,
      onData: (data) => {
        term.screen.write(data);
        term.viewer?.onData(data);
        // A bell on a terminal nobody is watching means an agent wants the
        // user — flag it in the catalog (the in-app dot) and push. A viewer
        // that's foregrounded means the user is already here, so stay quiet; a
        // backgrounded viewer (phone locked/switched away) counts as not
        // watching, so still notify.
        const watching =
          term.viewer != null && term.viewer.isForeground?.() !== false;
        if (!term.closing && !watching && data.includes(BEL)) {
          if (!term.meta.needsAttention) {
            term.meta = { ...term.meta, needsAttention: true };
            this.notifyCatalog();
          }
          this.maybeNotifyAttention(term);
        }
      },
      onExit: (exitCode) => {
        // Sole removal path — close() funnels here too via kill(), so the
        // viewer (possibly on another device) sees the exit.
        if (this.terminals.delete(term.meta.terminalId)) {
          term.viewer?.onExit(exitCode);
          term.viewer = null;
          term.screen.dispose();
          this.notifyCatalog();
        }
      },
    });
    term.meta = {
      ...term.meta,
      terminalId: term.handle.id,
      cwd: term.handle.cwd,
    };
    this.terminals.set(term.meta.terminalId, term);
    this.notifyCatalog();
    return term.meta;
  }

  /**
   * Become the viewer and get a snapshot reproducing the current screen;
   * returns null for unknown ids, "busy" if another subscriber is viewing
   * and takeover wasn't requested (takeover kicks them via onTakenOver).
   * The snapshot resolves asynchronously: the headless terminal parses
   * writes in chunks, so the serialize has to queue behind everything
   * already written — otherwise a reattach could miss the tail.
   */
  attach(
    terminalId: string,
    cols: number,
    rows: number,
    subscriber: TerminalSubscriber,
    takeover: boolean,
  ):
    | {
        meta: TerminalMeta;
        snapshot: Promise<string>;
        detach: () => void;
      }
    | "busy"
    | null {
    const term = this.terminals.get(terminalId);
    if (!term) return null;
    if (term.viewer && term.viewer !== subscriber) {
      if (!takeover) return "busy";
      term.viewer.onTakenOver();
    }
    term.viewer = subscriber;
    // Resize before serializing — the headless buffer reflows, so the
    // snapshot is laid out for the attaching client's dimensions.
    term.handle.resize(cols, rows);
    term.screen.resize(
      Math.min(500, Math.max(2, Math.round(cols))),
      Math.min(500, Math.max(2, Math.round(rows))),
    );
    const snapshot = new Promise<string>((resolve) => {
      term.screen.write("", () => resolve(term.serializer.serialize()));
    });
    return {
      meta: term.meta,
      snapshot,
      // Identity-guarded: a stale detach (kicked viewer, replaced attach)
      // must not free someone else's view.
      detach: () => {
        if (term.viewer === subscriber) term.viewer = null;
      },
    };
  }

  get(terminalId: string): TerminalHandle | undefined {
    return this.terminals.get(terminalId)?.handle;
  }

  /** Kill a terminal; removal and notifications happen in the exit callback. */
  close(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    // Suppress the bell the agent may emit while tearing down — the user asked
    // for this kill, so it must not fire an attention notification.
    term.closing = true;
    term.handle.kill();
  }

  list(): TerminalMeta[] {
    return [...this.terminals.values()]
      .map((t) => t.meta)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Clear a session's attention flag — the user looked at it. Broadcasts the
   * updated catalog so the dot clears on every connected client. No-op if the
   * terminal is unknown or already clear.
   */
  markSeen(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (term?.meta.needsAttention) {
      term.meta = { ...term.meta, needsAttention: false };
      this.notifyCatalog();
    }
  }

  private notifyCatalog(): void {
    for (const fn of this.catalogListeners) fn();
  }

  /** Fire the attention listeners, debounced per terminal. */
  private maybeNotifyAttention(term: PersistentTerminal): void {
    const now = Date.now();
    if (now - term.lastAttentionAt < ATTENTION_DEBOUNCE_MS) return;
    term.lastAttentionAt = now;
    for (const fn of this.attentionListeners) fn(term.meta);
  }
}
