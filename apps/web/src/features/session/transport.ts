/**
 * Transports between the app and the daemon. Both deliver the same
 * schema-validated protocol text; everything above this file is
 * transport-agnostic.
 *
 * - direct: plain WebSocket to the daemon on the local network (dev setup).
 * - relay:  WebSocket to the relay + E2E encryption. The relay only ever
 *           sees ciphertext; the handshake authenticates the daemon via its
 *           pinned key and this device via its key (or a pairing secret on
 *           first contact).
 */
import {
  decodeRelayClientControl,
  roomIdFor,
  startClientHandshake,
  type KeyPair,
  type SecureChannel,
} from "@clawdot/protocol/tunnel";

export interface Transport {
  send(text: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** Connection ended (any reason) — schedule a reconnect if appropriate. */
  onClose(): void;
  /**
   * Relay only: the E2E handshake failed — wrong/expired/used ticket or a
   * revoked device. Reconnecting with the same credentials will not help.
   * onClose still follows.
   */
  onAuthFailure?(reason: string): void;
}

const HANDSHAKE_TIMEOUT_MS = 8000;

export function connectDirect(url: string, handlers: TransportHandlers): Transport {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") handlers.onMessage(e.data);
  };
  ws.onclose = () => handlers.onClose();
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => ws.close(),
  };
}

export function connectRelay(
  opts: {
    relayUrl: string;
    daemonKey: Uint8Array;
    deviceKeyPair: KeyPair;
    /** Present on first contact only. */
    pairingSecret?: Uint8Array;
  },
  handlers: TransportHandlers,
): Transport {
  const ws = new WebSocket(opts.relayUrl);
  ws.binaryType = "arraybuffer";
  let channel: SecureChannel | null = null;
  let handshake: ReturnType<typeof startClientHandshake> | null = null;

  // A rejected handshake is silence (the daemon tells strangers nothing), so
  // auth failure surfaces as a timeout here.
  const handshakeTimer = setTimeout(() => {
    if (!channel) {
      handlers.onAuthFailure?.(
        "the daemon did not accept this device — the pairing code may be expired or already used",
      );
      ws.close();
    }
  }, HANDSHAKE_TIMEOUT_MS);

  ws.onopen = () => {
    ws.send(JSON.stringify({ role: "client", room: roomIdFor(opts.daemonKey) }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const ctl = decodeRelayClientControl(e.data);
      if (ctl?.type === "ready") {
        handshake = startClientHandshake({
          daemonKey: opts.daemonKey,
          deviceKeyPair: opts.deviceKeyPair,
          pairingSecret: opts.pairingSecret,
        });
        ws.send(handshake.hello);
      }
      // "close" controls are followed by the socket closing — onClose handles it
      return;
    }
    const frame = new Uint8Array(e.data as ArrayBuffer);
    if (!channel) {
      const established = handshake?.finish(frame) ?? null;
      if (!established) {
        clearTimeout(handshakeTimer);
        handlers.onAuthFailure?.("daemon authentication failed");
        ws.close();
        return;
      }
      channel = established;
      clearTimeout(handshakeTimer);
      handlers.onOpen();
      return;
    }
    const text = channel.openText(frame);
    if (text === null) {
      ws.close(); // tampered/desynced stream — never skip silently
      return;
    }
    handlers.onMessage(text);
  };
  ws.onclose = () => {
    clearTimeout(handshakeTimer);
    handlers.onClose();
  };

  return {
    send: (text) => {
      if (channel && ws.readyState === WebSocket.OPEN) ws.send(channel.sealText(text));
    },
    close: () => ws.close(),
  };
}
