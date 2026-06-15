import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalAgent, WorkspaceMeta } from "@clawdot/protocol";

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Daemon settings persisted in the data dir. All optional, no baked-in values. */
export interface DaemonConfig {
  /** Relay endpoint for remote access (wss://host/v1). */
  relayUrl?: string;
  /** Daemon listen port (the --port flag still wins). */
  port?: number;
  /** Commands launchable as terminal sessions (settings dialog in the app). */
  terminalAgents?: TerminalAgent[];
  /** Hostnames the preview proxy may fetch beyond loopback (settings dialog). */
  previewAllowedHosts?: string[];
  /** Push a notification when an unwatched agent rings the bell. Default true. */
  notifyOnBell?: boolean;
  /**
   * Make the pairing token never expire and pair unlimited devices (instead of
   * the default 10-minute, one-device window). Local-only — like relay/port it
   * is never exposed in the app's settings dialog, since it widens who can
   * pair. Meant for handing a stable test link to reviewers (e.g. Apple staff).
   */
  unlimitedPairing?: boolean;
}

/**
 * Daemon settings that should survive restarts without being retyped — set
 * via `clawdot setup` / `clawdot config` or flags. Nothing here has a
 * baked-in value: whoever hosts their own relay points the daemon at it once
 * and it sticks.
 */
export class ConfigStore {
  readonly path: string;
  /** False on first run — `clawdot` uses this to suggest the setup wizard. */
  readonly existed: boolean;
  private config: DaemonConfig = {};

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "config.json");
    this.existed = existsSync(this.path);
    if (this.existed) {
      try {
        this.config = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        this.config = {};
      }
    }
  }

  get(): DaemonConfig {
    return { ...this.config };
  }

  /** Merge a patch; `undefined` values delete their key. */
  update(patch: Partial<Record<keyof DaemonConfig, DaemonConfig[keyof DaemonConfig] | undefined>>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") {
        delete this.config[key as keyof DaemonConfig];
      } else {
        (this.config as Record<string, unknown>)[key] = value;
      }
    }
    writeFileSync(this.path, JSON.stringify(this.config, null, 2));
  }

  get relayUrl(): string | null {
    return this.config.relayUrl ?? null;
  }

  set relayUrl(url: string | null) {
    this.update({ relayUrl: url ?? undefined });
  }
}

/**
 * Remembers every project directory the daemon has opened terminals in, so
 * clients can offer them as suggestions when opening a workspace — killing
 * a workspace's last terminal must not erase the workspace from the picker.
 */
export class WorkspaceStore {
  private readonly path: string;
  private workspaces: Record<string, number> = {}; // cwd → lastUsedAt
  private readonly listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "workspaces.json");
    if (existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, "utf8")) as Record<
          string,
          number
        >;
        for (const [cwd, lastUsedAt] of Object.entries(stored)) {
          const canonicalCwd = canonicalPath(cwd);
          this.workspaces[canonicalCwd] = Math.max(
            this.workspaces[canonicalCwd] ?? 0,
            lastUsedAt,
          );
        }
        if (Object.keys(stored).some((cwd) => canonicalPath(cwd) !== cwd)) {
          writeFileSync(this.path, JSON.stringify(this.workspaces, null, 2));
        }
      } catch {
        this.workspaces = {};
      }
    }
  }

  /** Record use of a workspace; keeps the most recent timestamp. */
  record(cwd: string, ts: number = Date.now()): void {
    const canonicalCwd = canonicalPath(cwd);
    if ((this.workspaces[canonicalCwd] ?? 0) >= ts) return;
    this.workspaces[canonicalCwd] = ts;
    writeFileSync(this.path, JSON.stringify(this.workspaces, null, 2));
    for (const fn of this.listeners) fn();
  }

  /** Forget a workspace. The directory itself is untouched. */
  remove(cwd: string): void {
    const canonicalCwd = canonicalPath(cwd);
    if (!(canonicalCwd in this.workspaces)) return;
    delete this.workspaces[canonicalCwd];
    writeFileSync(this.path, JSON.stringify(this.workspaces, null, 2));
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): WorkspaceMeta[] {
    return Object.entries(this.workspaces)
      .map(([cwd, lastUsedAt]) => ({ cwd, lastUsedAt }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}
