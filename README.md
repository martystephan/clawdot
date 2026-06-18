<div align="center">

<img src="./assets/icon.svg" width="96" alt="Clawdot icon" />

# Clawdot

**The mobile-first IDE for agentic coding**<br>
Build, test, and ship software from your phone — the agent runs on your own machine

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-417E38?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)

</div>

---

Clawdot lets you build, test, and ship software from your phone — powered by an AI coding agent running on your own machine. No cloud sandboxes, no server costs, no compromises. Your computer does the work; Clawdot is the cockpit.

## The Problem

Agentic coding tools like Claude Code are powerful, but they're built for the desktop. On a phone, you can watch an agent work — but you can't *verify* anything. There's no browser to open your web app, no way to hit your API endpoints, no feedback loop. Mobile "vibe coding" today means blindly trusting the agent and checking the results later at your desk.

## The Idea

Clawdot closes that loop with two core concepts:

### 1. Your machine, remotely

A lightweight CLI daemon runs on your computer (or home server) and hosts **terminal sessions**: real PTYs running the coding agents you already use (`claude`, `codex`, …) full-screen, exactly like in your desktop terminal. Your phone connects through an end-to-end encrypted tunnel — paired once via QR code. The relay server only forwards ciphertext; it never sees your code, your prompts, or your keys. Since all compute happens on hardware you already own — and the agent CLIs reuse the subscriptions you're already logged into — there are effectively zero running costs beyond what you already pay.

### 2. Generative test surfaces

This is what makes Clawdot different. The agent doesn't just write code — it builds the interface you need to verify it:

- **Building a web app?** The daemon runs a real headless browser on its own machine, opens your dev server in it, and streams the live tab into the IDE — so the previewed site sees the daemon's host (its IP, cookies, origin), never your phone, and there's no CORS or proxy glue to fight. You can even reach into the live DOM from the app.
- **Building a backend?** Instead of a useless browser tab, the agent assembles an interactive test panel from declarative building blocks: forms, buttons, and response viewers wired directly to the endpoints it just created. A purpose-built mini API client, generated on the fly.

Interactions flow back into the loop: press a test button, the request fails, the error lands in the agent's context, the agent fixes it. That's the feedback cycle mobile coding has been missing.

## Architecture

Clawdot is a pnpm monorepo with a protocol-first design — clients are just renderers, so new surfaces (desktop app, VS Code fork) plug into the same backbone later.

```
apps/
  web/        → React + Vite web app — the IDE UI, plus the Tauri 2 mobile shell (src-tauri/)
  cli/        → Node.js daemon — hosts terminal sessions (PTYs), manages workspaces and pairing
  relay/      → self-hostable ciphertext-only WebSocket forwarder (one bundled file on a VPS)
packages/
  protocol/   → shared message schemas (Zod), E2E tunnel crypto, protocol versioning
```

**Message flow:** The protocol separates `terminal.*` messages (PTY lifecycle, keystrokes, raw output) and `browser.*` messages (the remote-browser screencast + input) from `surface.*` events (higher-level things the client renders — test panels). Adding a new widget type never requires touching the transport layer.

**Terminal sessions are daemon-scoped.** Locking your phone drops the socket — and on mobile, it will constantly — so the agent process lives on the daemon, not the connection. The daemon feeds every PTY through a headless terminal; when you reattach (same phone or a different device), you get a serialized snapshot of the current screen plus scrollback and the live stream continues, with the agent never noticing you were gone.

**Remote access is end-to-end encrypted.** The daemon dials out to the relay (no port forwarding), each phone is a multiplexed channel on that socket, and every channel runs an X25519 handshake + ChaCha20-Poly1305 framing the relay cannot open. `clawdot pair` prints a QR code; scanning it opens the hosted web app with a one-time ticket in the URL fragment, and from then on the device's own key is the credential. The relay (plus the hosted web app) deploys as one container from the root `Dockerfile` — route your domain to container port 9700 and let the fronting proxy do TLS.

**The web preview is a remote browser, not a proxy.** The daemon drives a real headless Chromium on its own machine (via the Chrome DevTools Protocol), one tab per preview, and screencasts it into the app as JPEG frames over the same E2E-encrypted connection; your pointer and keyboard are forwarded back. Because the page actually executes on the daemon's host, the previewed site sees the daemon — its IP, DNS, cookies and real origin — so client-side routers, `pushState`, SSR hydration, cookie sessions and same-origin API calls all just work, with no service worker, no CORS escape hatch, and no DNS records or certificates to set up. The app can also evaluate JavaScript against the live DOM (the in-app console) — useful for assertions and, later, generative test surfaces. The first time it's needed the daemon uses a system Chrome if present, otherwise downloads a managed Chromium into the data dir once (~150 MB); set `CLAWDOT_CHROME` to point at a specific binary.

## Install

Install the CLI from npm:

```sh
npm install -g clawdot     # puts `clawdot` on PATH

clawdot                    # interactive menu — first run opens the setup wizard

# Everything is also a direct subcommand for scripting:
clawdot setup              # guided configuration (relay, port, background service)
clawdot service install    # run the daemon in the background — starts at login via
                           # launchd (macOS), a systemd user unit (Linux), or the
                           # Startup folder (Windows)
clawdot pair               # QR-pair a phone through the relay
clawdot devices            # list / revoke paired devices
clawdot config             # change settings later
clawdot serve              # …or run the daemon in the foreground instead
```

There is no default relay: you point the daemon at the one *you* host (the
root `Dockerfile`) and it sticks — via the wizard or `clawdot --relay <url>`.
Nothing in clawdot phones home anywhere you didn't configure.

## Mobile app

On a phone you can just open the hosted web app in the browser — it's the
full IDE and pairs with your daemon through the relay exactly as above.

The web frontend is also designed to be wrapped as a native app via a
Tauri 2 shell. That shell is **not committed** to this repository, because
it carries personal signing config (Apple Team ID, bundle identifier) and a
project-specific Firebase `GoogleService-Info.plist` for push. To build your
own, generate a fresh shell against `apps/web` with your own identifiers:

```sh
cd apps/web
pnpm tauri init          # scaffold src-tauri/ with your own bundle id
pnpm tauri ios init      # generate the iOS project (needs Rust + Xcode)
pnpm tauri ios dev       # build + run on a simulator
```

Building for a real device needs your own Apple signing team
(`bundle > iOS > developmentTeam` in `src-tauri/tauri.conf.json`), and push
notifications need your own Firebase project. The relay's FCM integration is
configured entirely from the environment (see the `Dockerfile`); no
credentials ship in this repo.

## Roadmap

- [x] Monorepo scaffold: web, cli, protocol packages
- [x] Protocol: message envelope, terminal/workspace/settings schemas, E2E tunnel crypto + pairing handshake
- [x] CLI daemon: persistent terminal sessions (PTYs) for any agent CLI, workspace tracking, relay connection + QR pairing
- [x] Relay server: minimal ciphertext-only WebSocket forwarder (self-hostable)
- [x] Web app: terminal session list, full-screen xterm.js views, reattach with scrollback replay
- [x] Remote-browser web preview: a real headless Chromium runs on the daemon and is screencast into the app over the E2E tunnel, with pointer/keyboard forwarded back — the previewed site sees the daemon's host, so routers/`pushState`/SSR/cookie sessions/same-origin APIs work with no proxy, CORS, or DNS setup
- [x] Live DOM access from the app: evaluate JavaScript against the previewed page (in-app console) — the substrate for assertions and generative test surfaces
- [ ] Generative test surfaces: declarative widget schema, API test panels
- [x] Native mobile app shell (Tauri 2 wrapper around the web app; iOS project generated, Android pending an SDK install)
- [ ] Desktop / VS Code integration

## Philosophy

- **Own your compute.** Your code runs on your hardware. The relay is a dumb, self-hostable pipe.
- **Protocol over platform.** Every client speaks the same schema-validated protocol. The UI is replaceable; the backbone isn't.
- **Verification is the product.** An agent that codes without letting you test is a demo. Clawdot makes the test loop first-class — especially on the device you always have with you.

## Status

🚧 Early development. Working today: the daemon runs persistent terminal sessions for any agent CLI (`claude`, `codex`, a plain shell — the list is editable in the app); the web app drives them full-screen via xterm.js and reattaches with a scrollback replay after a disconnect — locally or from anywhere through the self-hosted relay with QR pairing and end-to-end encryption. The first surface is in: a web preview that runs a real headless browser on the daemon's machine, opens your dev server in it, and streams the live tab into the app over the same encrypted connection (with input forwarded back and the page's DOM reachable from an in-app console).

## License

[MIT](./LICENSE)
