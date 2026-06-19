import { Globe, Menu } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { TerminalAgent } from "@clawdot/protocol";
import logoUrl from "../../../../assets/icon.svg";
import { AppProvider } from "@/app/provider";
import { Button, Chip, ErrorCard } from "@/components/ui";
import { PairDialog } from "@/features/session/components/pair-dialog";
import { SessionSidebar } from "@/features/session/components/session-sidebar";
import { SettingsDialog } from "@/features/session/components/settings-dialog";

// Lazy: xterm.js is heavy and many visits never open a terminal.
const TerminalSessionView = lazy(() =>
  import("@/features/session/components/terminal-session-view").then((m) => ({
    default: m.TerminalSessionView,
  })),
);
import { PreviewPanel } from "@/features/preview/components/preview-panel";
import { WorkspaceDialog } from "@/features/session/components/workspace-dialog";
import { useDaemon } from "@/features/session/hooks/use-daemon";
import type { ConnectionStatus } from "@/features/session/types";

const THEME_KEY = "clawdot.theme";
// Bucket for the right panel when no agent session is selected (home view).
const HOME_KEY = "__home__";

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
const NARROW_QUERY = "(max-width: 700px)";

function useTheme() {
  const [dark, setDark] = useState(
    () => localStorage.getItem(THEME_KEY) !== "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

/** Centered empty-state shell with consistent heading/copy styling. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-5 pb-10 pt-20 text-center [&_h2]:mb-1.5 [&_h2]:text-[19px] [&_h2]:font-[650] [&_h2]:tracking-[-0.01em] [&_p]:mb-5 [&_p]:max-w-95 [&_p]:text-fg-mid">
      {children}
    </div>
  );
}

/** Full-screen takeover while there is no daemon connection — pairing
 * instructions when unpaired, a connecting notice otherwise. The normal
 * layout (sidebar, header) only exists once connected. */
function ConnectScreen({
  status,
  lastError,
  onOpenPairing,
}: {
  status: ConnectionStatus;
  lastError: string | null;
  onOpenPairing: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto bg-panel px-6">
      {status === "unpaired" ? (
        <EmptyState>
          <img src={logoUrl} alt="" className="mb-3 size-7.5" />
          <h2>Pair this device</h2>
          <p>
            Run <span className="font-mono">clawdot pair</span> on the machine
            where the daemon runs, then scan the QR code — or paste the
            pairing code by hand.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Chip onClick={onOpenPairing}>Pair…</Chip>
          </div>
        </EmptyState>
      ) : (
        <EmptyState>
          <img src={logoUrl} alt="" className="mb-3 size-7.5" />
          <h2>Connecting…</h2>
          <p>Waiting for the daemon to answer.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Chip onClick={onOpenPairing}>Remote access…</Chip>
          </div>
        </EmptyState>
      )}
      {lastError && (
        <div className="w-full max-w-110 pb-10">
          <ErrorCard>{lastError}</ErrorCard>
        </div>
      )}
    </div>
  );
}

/** Main-area placeholder when no terminal session is selected. */
function HomeView({
  lastError,
  onNewTerminal,
}: {
  lastError: string | null;
  onNewTerminal: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-180 flex-col gap-4.5 px-6 pb-7.5 pt-5.5">
        <EmptyState>
          <img src={logoUrl} alt="" className="mb-3 size-7.5" />
          <h2>No terminal open</h2>
          <p>
            Pick a terminal session in the sidebar, or start an agent in a
            workspace — it keeps running even when this device disconnects.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Chip onClick={onNewTerminal}>New terminal…</Chip>
          </div>
        </EmptyState>
        {lastError && <ErrorCard>{lastError}</ErrorCard>}
      </div>
    </div>
  );
}

function SessionScreen() {
  const {
    status,
    terminals,
    attentionIds,
    clearAttention,
    terminalAgents,
    notifyOnBell,
    browser,
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
  } = useDaemon();
  const theme = useTheme();
  // On narrow (mobile) viewports the sidebar overlays the main view, so it
  // starts closed and closes again after picking a terminal.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_QUERY).matches,
  );
  // Track narrow (mobile) viewports reactively. There the sidebar is a
  // full-screen takeover, so an open sidebar fully hides the terminal — and we
  // detach it rather than keep an unwatched session attached in the background.
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // The main terminal view is hidden behind the sidebar takeover on mobile.
  const mainCovered = narrow && sidebarOpen;
  // Workspace picker open. addOnly=true means just register the workspace,
  // don't spawn a terminal.
  const [picking, setPicking] = useState<{
    agent: TerminalAgent | null;
    addOnly: boolean;
  } | null>(null);
  // Selected terminal session — takes over the main view.
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  // Whether the preview panel is open for each session — switching sessions
  // swaps it automatically since it's keyed by the session.
  const [previewBySession, setPreviewBySession] = useState<
    Record<string, boolean>
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Pairing failures should be visible even if the user never opened the
  // dialog (e.g. a scanned QR with a stale ticket).
  const [pairingOpen, setPairingOpen] = useState(false);
  useEffect(() => {
    if (pairingError) setPairingOpen(true);
  }, [pairingError]);

  // Window titles come from the daemon catalog (`terminals`): its headless
  // xterm tracks OSC title changes for every session and broadcasts them to
  // all clients, so titles stay current whether or not a session is selected.
  const activeTerm = terminals.find((t) => t.terminalId === activeTermId);
  const workspace = activeTerm?.cwd ?? null;

  // The preview panel is bound to the selected session (home gets its own
  // bucket). Toggling flips this session's panel; switching sessions reads a
  // different entry, so the panel follows the selection.
  const sessionKey = activeTermId ?? HOME_KEY;
  const previewOpen = previewBySession[sessionKey] ?? false;

  const liveIds = useMemo(
    () => new Set(terminals.map((t) => t.terminalId)),
    [terminals],
  );
  // Preview tabs live on past their panel's unmount (so switching sessions
  // keeps each session's browser alive in the background) — so close the tabs
  // of sessions that no longer exist. The active session is always retained,
  // covering the brief window before a just-opened terminal hits the catalog.
  useEffect(() => {
    browser.retainViews(new Set([...liveIds, HOME_KEY, sessionKey]));
  }, [browser, liveIds, sessionKey]);

  const togglePreview = () => {
    setPreviewBySession((s) => ({ ...s, [sessionKey]: !previewOpen }));
  };

  const closeSidebarIfNarrow = () => {
    if (window.matchMedia(NARROW_QUERY).matches) setSidebarOpen(false);
  };

  // Select a session and take the main view to it. Clearing its attention dot
  // happens in the effect below (so foregrounding onto it clears it too).
  const selectTerminal = (id: string) => {
    setActiveTermId(id);
    closeSidebarIfNarrow();
  };

  // The session you're actively viewing never carries an unread dot: mark it
  // seen when it becomes active, when the sidebar closes back onto it, and when
  // the app returns to the foreground. "Covered by the sidebar" doesn't count
  // as viewing, so opening the sidebar leaves the dot for when you come back.
  useEffect(() => {
    if (activeTermId && !mainCovered) clearAttention(activeTermId);
  }, [activeTermId, mainCovered, clearAttention]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeTermId && !mainCovered) {
        clearAttention(activeTermId);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [activeTermId, mainCovered, clearAttention]);

  // A session other than the one you're viewing needs attention — drives the
  // dot on the (mobile) burger button when the sidebar is closed.
  const hasHiddenAttention = useMemo(
    () => [...attentionIds].some((id) => id !== activeTermId),
    [attentionIds, activeTermId],
  );

  const openWorkspacePicker = (agent: TerminalAgent | null, addOnly = false) => {
    listDir(dirListing?.path);
    setPicking({ agent, addOnly });
  };

  /** Spawn a persistent agent terminal and switch the main view to it. */
  const openAgentTerminal = (target: string, agent: TerminalAgent | null) => {
    terminal.open(
      {
        cwd: target,
        cols: 80,
        rows: 24,
        persistent: true,
        ...(agent ? { command: agent.command, title: agent.name } : {}),
      },
      {
        onOpened: (id) => setActiveTermId(id),
        onData: () => {},
        onExit: () => {},
        onError: () => {},
        onBusy: () => {},
      },
    );
    closeSidebarIfNarrow();
  };

  return (
    <div className="flex h-full flex-col">
      {status !== "connected" ? (
        <ConnectScreen
          status={status}
          lastError={lastError}
          onOpenPairing={() => setPairingOpen(true)}
        />
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* On narrow viewports the panels take over the full screen (see
            .mobile-takeover in styles.css) and close via their own buttons. */}
        {sidebarOpen && (
          <SessionSidebar
            terminals={terminals}
            terminalAgents={terminalAgents}
            workspaces={workspaces}
            activeTerminalId={activeTermId}
            attentionIds={attentionIds}
            onSelectTerminal={selectTerminal}
            // Without an explicit cwd, new terminals stay in the active
            // workspace; with no workspace either, the user picks one first.
            onNewTerminal={(agent, cwd) => {
              const target = cwd ?? workspace;
              if (target) openAgentTerminal(target, agent);
              else openWorkspacePicker(agent);
            }}
            onAddWorkspace={() => openWorkspacePicker(null, true)}
            onRemoveWorkspace={removeWorkspace}
            // Killing the selected terminal deselects it right away — the
            // user asked for it to die, no "process exited" overlay needed.
            onKillTerminal={(id) => {
              terminal.close(id);
              if (id === activeTermId) setActiveTermId(null);
            }}
            remotePaired={remote !== null}
            onOpenPairing={() => setPairingOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleTheme={theme.toggle}
          />
        )}

        <section className="flex min-w-0 flex-1 flex-col bg-panel">
          <header className="flex min-h-10.5 items-center gap-2.5 border-b border-border px-4 py-2.25">
            <Button
              size="icon"
              className="relative"
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              onClick={() => setSidebarOpen((o) => !o)}
            >
              <Menu size={16} />
              {/* Another session needs attention but the sidebar (with its
                  per-session dots) is closed — surface it on the burger. */}
              {!sidebarOpen && hasHiddenAttention && (
                <span className="absolute right-0.5 top-0.5 size-1.75 rounded-full bg-info ring-2 ring-panel" />
              )}
            </Button>
            {/* The session title and full path live in the sidebar / hover
                title — the header just names the workspace. */}
            <span
              className="truncate font-semibold"
              title={
                activeTerm ? `${activeTerm.title} — ${activeTerm.cwd}` : undefined
              }
            >
              {workspace ? basename(workspace) : (activeTerm?.title ?? "No terminal")}
            </span>
            <span className="flex-1" />
            <Button
              size="icon"
              title="Toggle web preview"
              aria-label="Toggle web preview"
              onClick={togglePreview}
            >
              <Globe size={15} className={previewOpen ? "text-fg" : undefined} />
            </Button>
          </header>

          {/* Covered by the sidebar takeover on mobile → render nothing so the
              session detaches (no unwatched terminal held in the background);
              reopening the view reattaches and replays the snapshot. */}
          {mainCovered ? null : activeTermId ? (
            <Suspense fallback={null}>
              <TerminalSessionView
                key={activeTermId}
                connected
                terminalId={activeTermId}
                terminal={terminal}
                onDismiss={() => setActiveTermId(null)}
              />
            </Suspense>
          ) : (
            <HomeView
              lastError={lastError}
              onNewTerminal={() => openWorkspacePicker(null)}
            />
          )}
        </section>

        {/* Keyed by session so switching remounts onto that session's
            preview port. */}
        {previewOpen && (
          <PreviewPanel
            key={sessionKey}
            storageKey={sessionKey}
            browser={browser}
            onClose={togglePreview}
          />
        )}
      </div>
      )}

      <PairDialog
        open={pairingOpen}
        remote={remote}
        pairingError={pairingError}
        connected={status === "connected"}
        onPair={pairWithCode}
        onUnpair={unpair}
        onClose={() => setPairingOpen(false)}
      />

      {settingsOpen && (
        <SettingsDialog
          agents={terminalAgents}
          notifyOnBell={notifyOnBell}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <WorkspaceDialog
        open={picking !== null}
        listing={dirListing}
        recents={workspaces}
        error={fsError}
        onNavigate={listDir}
        onMakeDir={makeDir}
        onOpen={(path) => {
          if (picking) {
            if (picking.addOnly) addWorkspace(path);
            else openAgentTerminal(path, picking.agent);
          }
          setPicking(null);
        }}
        onClose={() => setPicking(null)}
      />
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <SessionScreen />
    </AppProvider>
  );
}
