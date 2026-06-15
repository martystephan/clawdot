import { ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ResizeHandle, TextInput, usePanelWidth } from "@/components/ui";

/** Per-session port memory: each terminal session remembers its own preview
 *  port (the panel is keyed by session, so this initializer reads the right
 *  one on mount and switching sessions swaps the whole panel). */
const portKey = (storageKey: string) => `clawdot.preview.port.${storageKey}`;

/** How long the companion gets to come up before falling back to path mode. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Origin mode wants a preview subdomain of the host we were loaded from.
 * Impossible for IP literals (no subdomains) and inside the Tauri shell
 * (the origin is the app bundle). `*.localhost` resolves to loopback in
 * Chrome/Firefox, so dev qualifies; where DNS doesn't actually cooperate,
 * the probe times out and we fall back.
 */
function canTryOriginMode(): boolean {
  if ("__TAURI_INTERNALS__" in window) return false;
  const h = location.hostname;
  if (/^[\d.]+$/.test(h) || h.startsWith("[")) return false;
  return "serviceWorker" in navigator;
}

/**
 * The subdomain shapes a preview origin can take, probed concurrently —
 * whichever companion answers first wins:
 * - `preview.<host>`: ONE ordinary DNS record and an ordinary certificate
 *   (no wildcard cert, which Let's Encrypt only grants via DNS-API
 *   challenges) — the recommended self-host setup. The port travels in the
 *   companion's URL instead of the hostname.
 * - `p<port>.<host>`: wildcard DNS; one origin per port, so two previews
 *   don't share browser storage.
 */
const originCandidates = (port: number): string[] => [
  `${location.protocol}//preview.${location.host}`,
  `${location.protocol}//p${port}.${location.host}`,
];

type PreviewMode = "probing" | "origin" | "path";

/**
 * Right-side web preview: an iframe onto a dev server running on the
 * daemon's machine, proxied through the encrypted daemon connection by a
 * service worker (see features/preview/bridge.ts). Two modes:
 *
 * - origin (preferred): the iframe lives on a preview subdomain, so the
 *   previewed app sees its real URL paths — client routers, pushState and
 *   SSR hydration work. Needs the DNS record(s) above pointing at the
 *   relay; a hidden companion iframe on that origin registers the service
 *   worker there and relays it to the app's bridge. The companion must
 *   stay mounted while the preview is open — it IS the proxy's message
 *   path, which is also why reloads (epoch) must not remount it; only a
 *   fresh probe (probeEpoch) may.
 * - path (fallback): `/preview/<port>/` on our own origin — Tauri shell,
 *   IP-literal hosts, or no preview DNS record (the probe timed out).
 */
export function PreviewPanel({
  connected,
  storageKey,
  attachCompanion,
  onClose,
}: {
  connected: boolean;
  /** Namespaces the remembered port — one per terminal session. */
  storageKey: string;
  /** Hands a companion MessagePort to the preview bridge; returns detach. */
  attachCompanion: (port: MessagePort) => () => void;
  onClose: () => void;
}) {
  const [port, setPort] = useState(
    () => localStorage.getItem(portKey(storageKey)) ?? "",
  );
  // The port being shown; null until the user opens one.
  const [active, setActive] = useState<number | null>(null);
  // Bumped to remount the preview iframe (reload). NOT the companion.
  const [epoch, setEpoch] = useState(0);
  // Bumped per probe — remounts the companions so they re-handshake.
  const [probeEpoch, setProbeEpoch] = useState(0);
  const [mode, setMode] = useState<PreviewMode | null>(null);
  // The winning preview origin (origin mode), e.g. https://preview.host.
  const [previewBase, setPreviewBase] = useState<string | null>(null);
  const modeRef = useRef<PreviewMode | null>(null);
  modeRef.current = mode;
  // Active companion link to the bridge, undone on close/port change.
  const detachRef = useRef<(() => void) | null>(null);
  // Candidates that reported failure this probe; all failed → path mode.
  const failedRef = useRef(0);

  // Path mode only works once the service worker controls this origin —
  // before that, /preview/… would fall through to the SPA fallback and the
  // iframe would render the app itself.
  const [swState, setSwState] = useState<"pending" | "ready" | "unsupported">(
    () => ("serviceWorker" in navigator ? "pending" : "unsupported"),
  );
  useEffect(() => {
    if (swState !== "pending") return;
    let disposed = false;
    void navigator.serviceWorker.ready.then(() => {
      if (!disposed) setSwState("ready");
    });
    return () => {
      disposed = true;
    };
  }, [swState]);

  // The probe deadline: missing wildcard DNS means the companion iframe
  // never loads (no error event to rely on), so a timer is the only signal.
  useEffect(() => {
    if (mode !== "probing") return;
    const timer = setTimeout(() => setMode("path"), PROBE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [mode, active]);

  // Port changed or panel closing — the old companion link is dead.
  useEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
    },
    [active],
  );

  const onCompanionLoad = (el: HTMLIFrameElement, base: string) => {
    const target = el.contentWindow;
    if (!target || active === null) return;
    const candidateCount = originCandidates(active).length;
    const channel = new MessageChannel();
    let settled = false;
    channel.port1.onmessage = (e: MessageEvent) => {
      if (settled) return;
      settled = true;
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "clawdot.companion.ready" && modeRef.current === "probing") {
        // First candidate to answer wins; the bridge takes over the port
        // from here (it re-sets onmessage).
        detachRef.current = attachCompanion(channel.port1);
        setPreviewBase(base);
        setMode("origin");
      } else if (modeRef.current === "probing") {
        // This candidate failed — the other may still answer; only when
        // every candidate has failed is waiting for the timeout pointless.
        failedRef.current += 1;
        if (failedRef.current >= candidateCount) setMode("path");
      }
    };
    target.postMessage({ type: "clawdot.companion.init" }, base, [
      channel.port2,
    ]);
  };

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(port.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return;
    localStorage.setItem(portKey(storageKey), port.trim());
    detachRef.current?.();
    detachRef.current = null;
    failedRef.current = 0;
    setPreviewBase(null);
    setActive(parsed);
    setEpoch((n) => n + 1);
    setProbeEpoch((n) => n + 1);
    setMode(canTryOriginMode() ? "probing" : "path");
  };

  // The new-tab target — null until the probe has settled on a mode, so a
  // click can't open the path-mode URL of a preview about to be origin-mode.
  const externalUrl =
    active === null || mode === null || mode === "probing"
      ? null
      : mode === "origin" && previewBase !== null
        ? `${previewBase}/`
        : `/preview/${active}/`;

  // Shared with the terminal panel — they occupy the same edge, one at a time.
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
        <Globe size={14} className="text-fg-mid" />
        <span className="font-[550]">Preview</span>
        <span className="flex-1" />
        {active !== null && (
          <>
            <Button
              size="icon"
              title="Reload preview"
              aria-label="Reload preview"
              onClick={() => setEpoch((n) => n + 1)}
            >
              <RotateCw size={13} />
            </Button>
            <Button
              size="icon"
              title="Open in new tab"
              aria-label="Open in new tab"
              disabled={externalUrl === null}
              onClick={() => externalUrl && window.open(externalUrl, "_blank")}
            >
              <ExternalLink size={13} />
            </Button>
          </>
        )}
        <Button
          size="icon"
          title="Close preview"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X size={13} />
        </Button>
      </div>

      <form
        className="flex items-center gap-2 border-b border-border px-3 py-2"
        onSubmit={open}
      >
        <span className="shrink-0 font-mono text-[11.5px] text-fg-faint">
          localhost:
        </span>
        <TextInput
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="5173"
          inputMode="numeric"
          aria-label="Dev server port"
        />
        <Button type="submit" disabled={swState !== "ready" || !connected}>
          Open
        </Button>
      </form>

      {active !== null && mode !== null ? (
        <>
          {/* The companions are the SW↔app message path in origin mode —
              the winner stays mounted (hidden, stable key) for the
              preview's whole lifetime; losers unmount once a base is
              chosen. Keyed by probeEpoch so a fresh probe re-handshakes,
              while reloads (epoch) leave them alone. */}
          {mode !== "path" &&
            originCandidates(active)
              .filter((base) => previewBase === null || base === previewBase)
              .map((base) => (
                <iframe
                  key={`companion-${base}-${active}-${probeEpoch}`}
                  src={`${base}/__clawdot/preview-bridge.html?port=${active}`}
                  onLoad={(e) => onCompanionLoad(e.currentTarget, base)}
                  title="Preview bridge"
                  aria-hidden
                  className="hidden"
                />
              ))}
          {mode === "probing" || (mode === "origin" && previewBase === null) ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <Globe size={18} className="text-fg-faint" />
              <p className="text-[12.5px] text-fg-mid">Preparing preview…</p>
            </div>
          ) : (
            <iframe
              key={epoch}
              src={
                mode === "origin" && previewBase !== null
                  ? `${previewBase}/`
                  : `/preview/${active}/`
              }
              title={`Preview of localhost:${active}`}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          )}
          {mode === "path" && canTryOriginMode() && (
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-fg-faint">
              Compatibility mode — apps with client-side routing may misbehave.
              Add a DNS record for preview.{location.hostname} pointing at
              your relay (plus a matching HTTPS domain entry) to enable
              full-fidelity previews.
            </p>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <Globe size={18} className="text-fg-faint" />
          <p className="text-[12.5px] text-fg-mid">
            {swState === "unsupported"
              ? "Preview needs a secure context (HTTPS or localhost) — service workers are unavailable here."
              : "Enter the port of a dev server running on the daemon's machine — it's tunneled through your encrypted connection."}
          </p>
        </div>
      )}
      <ResizeHandle
        edge="left"
        width={width}
        onResize={resize}
        label="Resize preview panel"
      />
    </aside>
  );
}
