# clawdot

Run coding agents (`claude`, `codex`, …) in terminal sessions on your own
machine and drive them from your phone. The daemon hosts the terminals; your
phone connects through a relay **you host**, end-to-end encrypted — the relay
only ever sees ciphertext.

## Install

```sh
npm install -g @clawdot/cli
clawdot          # interactive menu — the first run opens the setup wizard
```

The wizard configures the relay and port, detects your platform, and offers
to install the daemon as a background service that starts at login and
restarts after crashes:

| Platform | Mechanism |
| -------- | --------- |
| macOS    | launchd LaunchAgent |
| Linux    | systemd user unit (needs a systemd user manager — the wizard tells you if there is none, e.g. in WSL or containers) |
| Windows  | Startup-folder launcher (no admin rights needed) |

No background service available? `clawdot serve` runs the daemon in the
foreground anywhere Node 20+ runs.

Linux note: the bundled PTY binaries are prebuilt for glibc — Alpine/musl is
not supported.

## Commands

```sh
clawdot setup              # guided configuration (relay, port, background service)
clawdot service install    # install/update the background service
clawdot pair               # QR-pair a phone through your relay
clawdot devices            # list / revoke paired devices
clawdot config             # change settings later
clawdot serve              # run the daemon in the foreground
```

## Remote access

There is no default relay and nothing phones home: you deploy the relay
container yourself and point the daemon at it (the wizard, or
`clawdot --relay wss://your-domain/v1`). Pairing uses a one-time QR ticket;
afterwards each device's own key is its credential. See the
[project repository](https://github.com/martystephan/clawdot) for the relay
Dockerfile and full documentation.
