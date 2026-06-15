import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeServer,
  encodeClient,
  type ClientMessage,
  type DirEntry,
  type TerminalAgent,
  type TerminalMeta,
  type WorkspaceMeta,
} from "@clawdot/protocol";
import {
  decodeTicket,
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  toBase64Url,
  type KeyPair,
  type PairingTicket,
} from "@clawdot/protocol/tunnel";
import {
  clearRemoteLink,
  daemonUrl,
  loadRemoteLink,
  saveRemoteLink,
} from "@/config";
import {
  createPreviewBridge,
  type PreviewBridge,
} from "@/features/preview/bridge";
import { acquirePushToken } from "@/features/notifications/register";
import {
  connectDirect,
  connectRelay,
  type Transport,
} from "@/features/session/transport";
import type { ConnectionStatus } from "@/features/session/types";

const RECONNECT_DELAY_MS = 1500;

/** One fs.list response — what the workspace picker renders. */
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  /** Windows drive roots ("C:\", "D:\") for the volume switcher; absent elsewhere. */
  volumes?: string[] | undefined;
}

/** What the UI needs to know about the remote link. */
export interface RemoteInfo {
  relayUrl: string;
}

/** First contact in progress: ticket + the device identity being enrolled. */
interface PendingPairing {
  ticket: PairingTicket;
  deviceKeyPair: KeyPair;
}

/** What a terminal view registers when it opens a PTY on the daemon. */
export interface TerminalEvents {
  onOpened(terminalId: string): void;
  onData(data: string): void;
  /** null exit code = the connection dropped, taking the PTY with it. */
  onExit(exitCode: number | null): void;
  onError(message: string): void;
  /** Another device is viewing (attach refused, or this view was kicked). */
  onBusy(): void;
}

/** Handle for driving daemon-side PTYs; returned by useDaemon. */
export interface TerminalApi {
  open(
    opts: {
      cwd?: string;
      cols: number;
      rows: number;
      command?: string;
      title?: string;
      persistent?: boolean;
    },
    events: TerminalEvents,
  ): void;
  /** Subscribe to a persistent terminal; onOpened fires on terminal.attached. */
  attach(
    terminalId: string,
    cols: number,
    rows: number,
    events: TerminalEvents,
    /** Steal the view from a connection that's currently watching. */
    takeover?: boolean,
  ): void;
  /** Unsubscribe without killing — the agent keeps running daemon-side. */
  detach(terminalId: string): void;
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
}

/** Read and consume a #pair=… fragment (QR scans land here). */
function takePairFragment(): string | null {
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match || !match[1]) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(match[1]);
}

/**
 * Connection to the clawdot daemon — directly on the local network, or
 * through the relay with end-to-end encryption once the device is paired.
 * Reconnects automatically; terminal views reattach themselves (persistent
 * terminals replay their scrollback from the daemon's headless screen).
 */
export function useDaemon() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [terminals, setTerminals] = useState<TerminalMeta[]>([]);
  // Sessions flagged for attention — derived from the daemon catalog, so it's
  // authoritative: survives reconnects and stays consistent across devices.
  const attentionIds = useMemo(
    () =>
      new Set(terminals.filter((t) => t.needsAttention).map((t) => t.terminalId)),
    [terminals],
  );
  const [terminalAgents, setTerminalAgents] = useState<TerminalAgent[]>([]);
  // Hosts the preview proxy may fetch beyond loopback (settings).
  const [previewAllowedHosts, setPreviewAllowedHosts] = useState<string[]>([]);
  // Whether an unwatched agent bell pushes a notification (settings).
  const [notifyOnBell, setNotifyOnBell] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteInfo | null>(() => {
    const link = loadRemoteLink();
    return link ? { relayUrl: link.relayUrl } : null;
  });
  const [pairingError, setPairingError] = useState<string | null>(null);
  // Bumped whenever the link changes (pair, unpair) to rebuild the transport.
  const [linkEpoch, setLinkEpoch] = useState(0);
  const transportRef = useRef<Transport | null>(null);
  const pendingPairingRef = useRef<PendingPairing | null>(null);
  // Live terminals by id, plus opens awaiting their terminal.opened reply
  // (the daemon answers in order, so a queue is enough to correlate them).
  const terminalsRef = useRef(new Map<string, TerminalEvents>());
  const pendingTerminalsRef = useRef<TerminalEvents[]>([]);
  // Push registration runs a long poll for the FCM token; this keeps one in
  // flight at a time and stops once the token is registered.
  const pushStateRef = useRef({ polling: false, registered: false });

  // A QR scan opens the app with the ticket in the fragment — consume it
  // before the first connection effect runs (initializer runs exactly once).
  const [fragmentTicketError] = useState<string | null>(() => {
    const code = takePairFragment();
    if (!code) return null;
    const ticket = decodeTicket(code);
    if (!ticket) return "invalid pairing link";
    pendingPairingRef.current = { ticket, deviceKeyPair: generateKeyPair() };
    return null;
  });

  const post = useCallback((msg: ClientMessage) => {
    transportRef.current?.send(encodeClient(msg));
  }, []);

  // Mark a session as seen on the daemon (the user opened it); the daemon
  // clears its flag and re-broadcasts the catalog, clearing the dot everywhere.
  const clearAttention = useCallback(
    (terminalId: string) => post({ type: "terminal.seen", terminalId }),
    [post],
  );

  // Web preview plumbing: relays the service worker's intercepted HTTP and
  // the preview iframes' WebSockets through this connection (preview.*).
  const previewRef = useRef<PreviewBridge | null>(null);
  useEffect(() => {
    const bridge = createPreviewBridge(post);
    previewRef.current = bridge;
    return () => {
      previewRef.current = null;
      bridge.dispose();
    };
  }, [post]);

  useEffect(() => {
    if (fragmentTicketError) setPairingError(fragmentTicketError);
  }, [fragmentTicketError]);

  // Tell the daemon when the app backgrounds/foregrounds so it can notify on a
  // bell even while a viewer is still attached (the socket can stay "connected"
  // long after the user has switched away). No-op when disconnected.
  useEffect(() => {
    const onVisibility = () =>
      post({
        type: "terminal.presence",
        foreground: document.visibilityState === "visible",
      });
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [post]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    // Set when the handshake itself is rejected — reconnecting with the same
    // credentials can't succeed, so the loop stops until the user re-pairs.
    let authFailed = false;

    const send = (msg: ClientMessage) =>
      transportRef.current?.send(encodeClient(msg));

    const onOpen = () => {
      const pending = pendingPairingRef.current;
      if (pending) {
        // Pairing succeeded — persist the link; the device key is now the
        // credential and the one-time secret is gone for good.
        saveRemoteLink({
          relayUrl: pending.ticket.relayUrl,
          daemonKey: toBase64Url(pending.ticket.daemonKey),
          deviceSecret: toBase64Url(pending.deviceKeyPair.secretKey),
        });
        pendingPairingRef.current = null;
        setRemote({ relayUrl: pending.ticket.relayUrl });
        setPairingError(null);
      }
      setStatus("connected");
      send({ type: "workspace.list" });
      send({ type: "terminal.list" });
      send({ type: "settings.get" });
      // Sync foreground state so a reconnect (or a connect while hidden) starts
      // the daemon's notification gating correct, not assuming foreground.
      send({
        type: "terminal.presence",
        foreground: document.visibilityState === "visible",
      });
      // Register this device for push (native shells only; no-op in a browser).
      // One long poll at a time; stop once registered. A dropped connection
      // mid-poll just leaves registered=false, so the next connect retries.
      const push = pushStateRef.current;
      if (!push.registered && !push.polling) {
        push.polling = true;
        void acquirePushToken().then((reg) => {
          push.polling = false;
          if (reg) {
            send({ type: "notify.register", token: reg.token, platform: reg.platform });
            push.registered = true;
          }
        });
      }
    };

    const onMessage = (data: string) => {
      const msg = decodeServer(data);
      if (!msg) return;
      switch (msg.type) {
        case "workspace.list":
          setWorkspaces(msg.workspaces);
          break;
        case "fs.list":
          setDirListing({
            path: msg.path,
            parent: msg.parent,
            dirs: msg.dirs,
            volumes: msg.volumes,
          });
          setFsError(null);
          break;
        case "fs.error":
          setFsError(msg.message);
          break;
        case "pair.ticket":
        case "device.list":
          // Pairing/device management happens via the local CLI, not here.
          break;
        case "terminal.opened": {
          const events = pendingTerminalsRef.current.shift();
          if (!events) break;
          terminalsRef.current.set(msg.terminalId, events);
          events.onOpened(msg.terminalId);
          break;
        }
        case "terminal.attached":
          // The handlers were registered at attach time (the id was known).
          terminalsRef.current.get(msg.terminalId)?.onOpened(msg.terminalId);
          break;
        case "terminal.busy":
          terminalsRef.current.get(msg.terminalId)?.onBusy();
          break;
        case "terminal.list":
          setTerminals(msg.terminals);
          break;
        case "settings":
          setTerminalAgents(msg.terminalAgents);
          setPreviewAllowedHosts(msg.previewAllowedHosts);
          setNotifyOnBell(msg.notifyOnBell);
          // The service worker needs the allowlist to route cross-origin
          // preview requests — keep the bridge's copy current.
          previewRef.current?.setAllowedHosts(msg.previewAllowedHosts);
          break;
        case "terminal.data":
          terminalsRef.current.get(msg.terminalId)?.onData(msg.data);
          break;
        case "terminal.exit": {
          const events = terminalsRef.current.get(msg.terminalId);
          terminalsRef.current.delete(msg.terminalId);
          events?.onExit(msg.exitCode);
          // No attention cleanup needed — an exited session leaves the catalog,
          // so its needsAttention flag (and dot) goes with it.
          break;
        }
        case "terminal.error": {
          // A null terminalId means terminal.open itself failed — that error
          // belongs to the oldest still-unanswered open.
          const events = msg.terminalId
            ? terminalsRef.current.get(msg.terminalId)
            : pendingTerminalsRef.current.shift();
          events?.onError(msg.message);
          break;
        }
        case "preview.head":
        case "preview.body":
        case "preview.end":
        case "preview.error":
        case "preview.ws.opened":
        case "preview.ws.message":
        case "preview.ws.closed":
          previewRef.current?.handleServerMessage(msg);
          break;
        case "error":
          setLastError(msg.message);
          break;
      }
    };

    const connect = () => {
      setStatus("connecting");
      const pending = pendingPairingRef.current;
      const link = pending ? null : loadRemoteLink();
      const handlers = {
        onOpen,
        onMessage,
        onClose: () => {
          // The daemon kills a connection's PTYs with it, whatever the
          // reason — tell their views even when this effect is tearing down.
          for (const events of terminalsRef.current.values()) {
            events.onExit(null);
          }
          terminalsRef.current.clear();
          for (const events of pendingTerminalsRef.current) {
            events.onError("connection lost");
          }
          pendingTerminalsRef.current = [];
          previewRef.current?.connectionLost();
          if (disposed) return;
          setStatus("disconnected");
          if (authFailed) return;
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        },
        onAuthFailure: (reason: string) => {
          authFailed = true;
          pendingPairingRef.current = null;
          setPairingError(reason);
        },
      };

      if (pending) {
        transportRef.current = connectRelay(
          {
            relayUrl: pending.ticket.relayUrl,
            daemonKey: pending.ticket.daemonKey,
            deviceKeyPair: pending.deviceKeyPair,
            pairingSecret: pending.ticket.secret,
          },
          handlers,
        );
        return;
      }
      if (link) {
        const daemonKey = fromBase64Url(link.daemonKey);
        const deviceSecret = fromBase64Url(link.deviceSecret);
        if (daemonKey && deviceSecret) {
          transportRef.current = connectRelay(
            {
              relayUrl: link.relayUrl,
              daemonKey,
              deviceKeyPair: keyPairFromSecret(deviceSecret),
            },
            handlers,
          );
          return;
        }
        clearRemoteLink(); // unreadable link — fall back to direct
        setRemote(null);
      }
      const direct = daemonUrl();
      if (!direct) {
        // Nothing to connect to until the user pairs — pairing bumps
        // linkEpoch, which re-runs this effect with a remote link.
        setStatus("unpaired");
        return;
      }
      transportRef.current = connectDirect(direct, handlers);
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, [linkEpoch]); // eslint-disable-line react-hooks/exhaustive-deps -- handlers close over stable refs/setters

  /** Pair with a manually pasted code (the QR flow uses the URL fragment). */
  const pairWithCode = useCallback((code: string) => {
    const ticket = decodeTicket(code);
    if (!ticket) {
      setPairingError("invalid pairing code");
      return;
    }
    pendingPairingRef.current = { ticket, deviceKeyPair: generateKeyPair() };
    setPairingError(null);
    setLinkEpoch((epoch) => epoch + 1);
  }, []);

  /** Forget the remote link and go back to direct connections. */
  const unpair = useCallback(() => {
    clearRemoteLink();
    pendingPairingRef.current = null;
    setRemote(null);
    setPairingError(null);
    setLinkEpoch((epoch) => epoch + 1);
  }, []);

  /** Browse a directory on the daemon's machine; no path → home directory. */
  const listDir = useCallback(
    (path?: string) => {
      setFsError(null);
      post(path ? { type: "fs.list", path } : { type: "fs.list" });
    },
    [post],
  );

  const makeDir = useCallback(
    (path: string, name: string) => {
      setFsError(null);
      post({ type: "fs.mkdir", path, name });
    },
    [post],
  );

  /** Register a workspace without spawning a terminal. */
  const addWorkspace = useCallback(
    (cwd: string) => {
      post({ type: "workspace.add", cwd });
    },
    [post],
  );

  /** Forget a workspace (the daemon broadcasts the updated list). */
  const removeWorkspace = useCallback(
    (cwd: string) => {
      post({ type: "workspace.remove", cwd });
    },
    [post],
  );

  /** Stable so terminal views can hold it across reconnects. */
  const terminal = useMemo<TerminalApi>(
    () => ({
      open: (opts, events) => {
        pendingTerminalsRef.current.push(events);
        post({ type: "terminal.open", ...opts });
      },
      attach: (terminalId, cols, rows, events, takeover) => {
        terminalsRef.current.set(terminalId, events);
        post({
          type: "terminal.attach",
          terminalId,
          cols,
          rows,
          ...(takeover ? { takeover: true } : {}),
        });
      },
      detach: (terminalId) => {
        terminalsRef.current.delete(terminalId);
        post({ type: "terminal.detach", terminalId });
      },
      input: (terminalId, data) =>
        post({ type: "terminal.input", terminalId, data }),
      resize: (terminalId, cols, rows) =>
        post({ type: "terminal.resize", terminalId, cols, rows }),
      close: (terminalId) => {
        // Keep the handlers: the kill may come from elsewhere in the UI (the
        // sidebar X) while a view is attached — it learns via terminal.exit,
        // which is also what removes the handlers.
        post({ type: "terminal.close", terminalId });
      },
    }),
    [post],
  );

  /** Origin-mode previews: hand a companion iframe's MessagePort to the bridge. */
  const attachPreviewCompanion = useCallback(
    (port: MessagePort): (() => void) =>
      previewRef.current?.attachCompanion(port) ?? (() => {}),
    [],
  );

  const saveSettings = useCallback(
    (agents: TerminalAgent[], allowedHosts: string[], notifyOnBell: boolean) => {
      post({
        type: "settings.update",
        terminalAgents: agents,
        previewAllowedHosts: allowedHosts,
        notifyOnBell,
      });
    },
    [post],
  );

  return {
    status,
    terminals,
    attentionIds,
    clearAttention,
    terminalAgents,
    previewAllowedHosts,
    notifyOnBell,
    attachPreviewCompanion,
    saveSettings,
    workspaces,
    lastError,
    dirListing,
    fsError,
    remote,
    pairingError,
    pairWithCode,
    unpair,
    listDir,
    makeDir,
    addWorkspace,
    removeWorkspace,
    terminal,
  };
}
