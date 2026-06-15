/**
 * `clawdot service` — run the daemon as a background service that starts at
 * login and restarts if it crashes. macOS uses a launchd LaunchAgent, Linux a
 * systemd user unit, Windows a Startup-folder launcher (a hidden cmd
 * supervisor loop — no admin rights needed, unlike schtasks logon triggers).
 * "Install" is idempotent: re-running it updates the service definition and
 * restarts with the current binary ("update" is an alias). The service runs
 * `clawdot serve --data-dir <dataDir>`; port and relay still come from that
 * data dir's config.json at start time.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { bailIfCancelled, requireTty } from "./cli-ui.js";
import { DaemonClient } from "./daemon-client.js";

const LABEL = "com.clawdot.daemon";

export interface ServiceManager {
  /** Human description of what gets installed where. */
  readonly where: string;
  /** One-line description of the mechanism, for wizard/menu messaging. */
  readonly summary: string;
  /** Where to look when the daemon doesn't come up. */
  readonly logHint: string;
  installed(): boolean;
  running(): boolean;
  /** Install or update + (re)start. Throws with a readable message. */
  install(): void;
  uninstall(): void;
  restart(): void;
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/** Blocking sleep — the service plumbing is synchronous spawnSync territory. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Absolute node + entry script (through the npm global symlink). */
function entrypoint(): { node: string; script: string } {
  return { node: process.execPath, script: realpathSync(process.argv[1] ?? "") };
}

/**
 * Services don't inherit the user's shell PATH (launchd hands out the bare
 * system default), so agent binaries like `claude` or `codex` would be
 * invisible to the background daemon. Bake the PATH of the shell that ran
 * `service install` into the definition — re-run `service update` after
 * PATH-relevant changes.
 */
function installPath(): string {
  return process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
}

class LaunchdService implements ServiceManager {
  private readonly plistPath = join(
    homedir(),
    "Library/LaunchAgents",
    `${LABEL}.plist`,
  );
  private readonly domain = `gui/${process.getuid?.() ?? 501}`;
  readonly where: string;
  readonly summary = "launchd LaunchAgent (starts at login, restarts after crashes)";
  readonly logHint: string;

  constructor(private readonly dataDir: string) {
    this.where = this.plistPath;
    this.logHint = join(dataDir, "logs", "daemon.log");
  }

  installed(): boolean {
    return existsSync(this.plistPath);
  }

  running(): boolean {
    const { ok, out } = run("launchctl", ["print", `${this.domain}/${LABEL}`]);
    return ok && /state = running|pid = \d+/.test(out);
  }

  /** launchd knows the service (bootstrapped), whether or not it's running. */
  private loaded(): boolean {
    return run("launchctl", ["print", `${this.domain}/${LABEL}`]).ok;
  }

  /**
   * Boot the service out and wait until launchd has actually forgotten it.
   * Bootout is asynchronous — bootstrapping again while the old instance is
   * still tearing down fails with a transient I/O error, which used to
   * strand the service half-installed: definition on disk, nothing loaded.
   */
  private bootout(): void {
    run("launchctl", ["bootout", `${this.domain}/${LABEL}`]); // ok to fail
    for (let i = 0; i < 20 && this.loaded(); i++) sleep(250);
  }

  private bootstrap(): void {
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) sleep(500);
      const boot = run("launchctl", ["bootstrap", this.domain, this.plistPath]);
      if (boot.ok) return;
      lastError = boot.out;
    }
    throw new Error(`launchctl bootstrap failed: ${lastError || "unknown error"}`);
  }

  install(): void {
    const { node, script } = entrypoint();
    const logDir = join(this.dataDir, "logs");
    mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    const xml = (value: string) =>
      value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    writeFileSync(
      this.plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>serve</string>
    <string>--data-dir</string>
    <string>${xml(this.dataDir)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(installPath())}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>StandardOutPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
</dict>
</plist>
`,
    );
    this.bootout();
    this.bootstrap();
  }

  uninstall(): void {
    this.bootout();
    rmSync(this.plistPath, { force: true });
  }

  restart(): void {
    if (!this.installed()) {
      throw new Error("service is not installed — run `clawdot service install` first");
    }
    // The definition can exist without launchd knowing it (an earlier
    // bootstrap failed) — load it instead of kicking a service that isn't
    // there; RunAtLoad starts the daemon.
    if (!this.loaded()) {
      this.bootstrap();
      return;
    }
    const kick = run("launchctl", ["kickstart", "-k", `${this.domain}/${LABEL}`]);
    if (!kick.ok) {
      // Last resort: rebuild launchd's view from the definition on disk.
      this.bootout();
      this.bootstrap();
    }
  }
}

class SystemdService implements ServiceManager {
  private readonly unitDir = join(homedir(), ".config/systemd/user");
  private readonly unitPath = join(this.unitDir, "clawdot.service");
  readonly where: string;
  readonly summary = "systemd user unit (starts at login, restarts after crashes)";
  readonly logHint = "journalctl --user -u clawdot";

  constructor(private readonly dataDir: string) {
    this.where = this.unitPath;
  }

  installed(): boolean {
    return existsSync(this.unitPath);
  }

  running(): boolean {
    return run("systemctl", ["--user", "is-active", "--quiet", "clawdot"]).ok;
  }

  install(): void {
    const { node, script } = entrypoint();
    mkdirSync(this.unitDir, { recursive: true });
    writeFileSync(
      this.unitPath,
      `[Unit]
Description=Clawdot daemon
After=network-online.target

[Service]
ExecStart=${node} ${script} serve --data-dir ${this.dataDir}
Environment=PATH=${installPath()}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
    );
    run("systemctl", ["--user", "daemon-reload"]);
    const enable = run("systemctl", ["--user", "enable", "--now", "clawdot"]);
    if (!enable.ok) {
      throw new Error(`systemctl enable failed: ${enable.out || "unknown error"}`);
    }
    run("systemctl", ["--user", "restart", "clawdot"]);
  }

  uninstall(): void {
    run("systemctl", ["--user", "disable", "--now", "clawdot"]); // ok to fail
    rmSync(this.unitPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }

  restart(): void {
    if (!this.installed()) {
      throw new Error("service is not installed — run `clawdot service install` first");
    }
    // Pick up unit changes systemd hasn't seen yet before restarting.
    run("systemctl", ["--user", "daemon-reload"]);
    const restart = run("systemctl", ["--user", "restart", "clawdot"]);
    if (!restart.ok) {
      throw new Error(`systemctl restart failed: ${restart.out || "unknown error"}`);
    }
  }
}

/**
 * Windows: a `.vbs` launcher in the user's Startup folder (runs at logon, no
 * admin rights — schtasks logon triggers need elevation) starts a hidden
 * `daemon.cmd` supervisor in the data dir, which relaunches the daemon
 * whenever it exits (the KeepAlive equivalent). Stop/status work by finding
 * the cmd/node processes whose command line contains the data dir path.
 */
class WindowsStartupService implements ServiceManager {
  private readonly vbsPath: string;
  private readonly cmdPath: string;
  private readonly logFile: string;
  readonly where: string;
  readonly summary = "Startup-folder launcher (starts at logon, restarts after crashes)";
  readonly logHint: string;

  constructor(
    private readonly dataDir: string,
    appData: string,
  ) {
    this.vbsPath = join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "Clawdot.vbs",
    );
    this.cmdPath = join(dataDir, "service", "daemon.cmd");
    this.logFile = join(dataDir, "logs", "daemon.log");
    this.where = this.vbsPath;
    this.logHint = this.logFile;
  }

  installed(): boolean {
    return existsSync(this.vbsPath);
  }

  /** Run a PowerShell snippet (powershell.exe ships with every Windows). */
  private powershell(script: string): { ok: boolean; out: string } {
    return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }

  /** Single-quoted PowerShell string literal. */
  private psq(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  running(): boolean {
    const { ok, out } = this.powershell(
      `$marker=${this.psq(this.dataDir)}; ` +
        `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ` +
        `$_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains($marker) ` +
        `} | Measure-Object).Count`,
    );
    return ok && Number(out) > 0;
  }

  /**
   * Kill the supervisor before the daemon — the other way round, the loop
   * respawns node between the two kills.
   */
  private stop(): void {
    this.powershell(
      `$marker=${this.psq(this.dataDir)}; ` +
        `foreach ($n in @('cmd.exe','node.exe')) { ` +
        `Get-CimInstance Win32_Process -Filter "Name='$n'" | Where-Object { ` +
        `$_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains($marker) ` +
        `} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
    );
  }

  private start(): void {
    const launch = run("wscript.exe", [this.vbsPath]);
    if (!launch.ok) {
      throw new Error(`wscript failed to start the launcher: ${launch.out || "unknown error"}`);
    }
  }

  install(): void {
    const { node, script } = entrypoint();
    mkdirSync(dirname(this.cmdPath), { recursive: true });
    mkdirSync(dirname(this.logFile), { recursive: true });
    mkdirSync(dirname(this.vbsPath), { recursive: true });
    // Literal % must be doubled in batch files; \r\n endings are required —
    // cmd's GOTO label scanning is unreliable in LF-only files.
    const bat = (value: string) => value.replaceAll("%", "%%");
    writeFileSync(
      this.cmdPath,
      [
        "@echo off",
        "rem Clawdot daemon supervisor - generated by `clawdot service install`.",
        `set "PATH=${bat(installPath())}"`,
        'cd /d "%USERPROFILE%"',
        ":loop",
        `"${bat(node)}" "${bat(script)}" serve --data-dir "${bat(this.dataDir)}" >> "${bat(this.logFile)}" 2>&1`,
        "rem ~2s backoff before the relaunch (ping never needs console stdin).",
        "ping -n 3 127.0.0.1 >nul",
        "goto loop",
        "",
      ].join("\r\n"),
    );
    writeFileSync(
      this.vbsPath,
      [
        "' Clawdot daemon launcher - generated by `clawdot service install`.",
        `CreateObject("WScript.Shell").Run Chr(34) & "${this.cmdPath}" & Chr(34), 0, False`,
        "",
      ].join("\r\n"),
    );
    this.stop();
    this.start();
  }

  uninstall(): void {
    this.stop();
    rmSync(this.vbsPath, { force: true });
    rmSync(this.cmdPath, { force: true });
  }

  restart(): void {
    if (!this.installed()) {
      throw new Error("service is not installed — run `clawdot service install` first");
    }
    this.stop();
    this.start();
  }
}

export type ServiceSupport =
  | { ok: true; manager: ServiceManager }
  | { ok: false; reason: string };

/**
 * Figure out how (and whether) this system can run the daemon in the
 * background. Returns a readable reason instead of throwing so the setup
 * wizard can show it inline.
 */
export function detectService(dataDir: string): ServiceSupport {
  if (process.platform === "darwin") {
    return { ok: true, manager: new LaunchdService(dataDir) };
  }
  if (process.platform === "linux") {
    // Linux without a reachable systemd user manager is common: WSL distros,
    // containers, bare SSH sessions without lingering.
    const probe = run("systemctl", ["--user", "show-environment"]);
    if (!probe.ok) {
      return {
        ok: false,
        reason:
          "no systemd user manager is reachable (common in WSL, containers, and bare SSH sessions — " +
          "on a server, `loginctl enable-linger` may fix it) — run `clawdot serve` in a terminal instead",
      };
    }
    return { ok: true, manager: new SystemdService(dataDir) };
  }
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (!appData) {
      return {
        ok: false,
        reason: "%APPDATA% is not set — cannot locate the Startup folder; run `clawdot serve` instead",
      };
    }
    return { ok: true, manager: new WindowsStartupService(dataDir, appData) };
  }
  return {
    ok: false,
    reason: `background services are not supported on ${process.platform} yet — run \`clawdot serve\` in a terminal instead`,
  };
}

/** Poll the daemon's local socket until it answers (or give up). */
async function answering(port: number, attempts = 8): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const client = await DaemonClient.connect(port);
      client.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * Install/update + start, then wait for the daemon to answer. Shared by
 * `clawdot service install` and the setup wizard. Throws on install failure;
 * a non-answering daemon only warns (the service may still be booting).
 */
export async function installService(
  manager: ServiceManager,
  opts: { port: number },
): Promise<void> {
  const s = p.spinner();
  s.start("Installing the service");
  try {
    manager.install();
  } catch (err) {
    s.error("Install failed");
    throw err;
  }
  s.message("Waiting for the daemon to answer");
  const up = await answering(opts.port);
  if (up) {
    s.stop(`Service installed — daemon answering on ws://localhost:${opts.port}`);
  } else {
    s.error("Service installed, but the daemon is not answering yet");
    p.log.warn(`Check the log: ${manager.logHint}`);
  }
}

export async function runService(
  action: string | undefined,
  opts: { dataDir: string; port: number },
): Promise<void> {
  p.intro("clawdot service");

  const support = detectService(opts.dataDir);
  if (!support.ok) {
    p.cancel(support.reason);
    process.exitCode = 1;
    return;
  }
  const manager = support.manager;

  let chosen = action;
  if (!chosen) {
    requireTty("service");
    const state = manager.installed()
      ? manager.running()
        ? "installed and running"
        : "installed but not running"
      : "not installed";
    const pick = await p.select({
      message: `Background service is ${state} (${manager.where})`,
      options: [
        {
          value: "install",
          label: manager.installed() ? "Update (reinstall + restart)" : "Install",
          hint: manager.summary,
        },
        ...(manager.installed()
          ? [
              { value: "restart", label: "Restart" },
              { value: "uninstall", label: "Uninstall" },
            ]
          : []),
        { value: "status", label: "Status" },
        { value: "done", label: "Done" },
      ],
    });
    bailIfCancelled(pick);
    if (pick === "done") {
      p.outro("Nothing changed.");
      return;
    }
    chosen = pick;
  }
  if (chosen === "update") chosen = "install"; // install is idempotent

  try {
    switch (chosen) {
      case "install": {
        await installService(manager, opts);
        p.outro(`Definition: ${manager.where}`);
        break;
      }
      case "uninstall": {
        manager.uninstall();
        p.log.success("Service stopped and removed.");
        p.outro(`Removed: ${manager.where}`);
        break;
      }
      case "restart": {
        const s = p.spinner();
        s.start("Restarting");
        manager.restart();
        const up = await answering(opts.port);
        if (up) s.stop(`Restarted — daemon answering on ws://localhost:${opts.port}`);
        else s.error("Restarted, but the daemon is not answering yet");
        p.outro("Done.");
        break;
      }
      case "status": {
        const installed = manager.installed();
        const running = installed && manager.running();
        const up = await answering(opts.port, 1);
        p.log.info(
          [
            `definition: ${installed ? manager.where : "not installed"}`,
            `service:    ${running ? "running" : "not running"}`,
            `daemon:     ${up ? `answering on ws://localhost:${opts.port}` : "not answering"}`,
          ].join("\n"),
        );
        if (installed && !running) {
          p.log.warn(
            "The definition exists but the service is not running — `clawdot service restart` will (re)load it.",
          );
        }
        p.outro("Done.");
        break;
      }
      default:
        p.cancel(
          `unknown action: ${chosen} (expected install, update, uninstall, restart or status)`,
        );
        process.exitCode = 1;
    }
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
