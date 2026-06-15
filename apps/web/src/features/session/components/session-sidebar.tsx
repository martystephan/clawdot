import {
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Plus,
  Settings,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { TerminalAgent, TerminalMeta, WorkspaceMeta } from "@clawdot/protocol";
import logoUrl from "../../../../../../assets/icon.svg";
import {
  Button,
  Collapsible,
  Menu,
  MenuItem,
  MenuSeparator,
  ResizeHandle,
  usePanelWidth,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { NotificationHub } from "./notification-hub";

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/**
 * Every persisted workspace plus terminal sessions grouped into them, most
 * recently used first. Workspaces without live sessions still show up —
 * sessions die with a daemon restart, but the workspaces survive it.
 */
function groupByWorkspace(
  terminals: TerminalMeta[],
  workspaces: WorkspaceMeta[],
) {
  const groups = new Map<
    string,
    { terminals: TerminalMeta[]; lastActive: number }
  >();
  for (const w of workspaces) {
    groups.set(w.cwd, { terminals: [], lastActive: w.lastUsedAt });
  }
  for (const t of terminals) {
    let group = groups.get(t.cwd);
    if (!group) {
      group = { terminals: [], lastActive: 0 };
      groups.set(t.cwd, group);
    }
    group.terminals.push(t);
    group.lastActive = Math.max(group.lastActive, t.createdAt);
  }
  return [...groups.entries()]
    .map(([cwd, group]) => ({ cwd, ...group }))
    .sort((a, b) => b.lastActive - a.lastActive);
}

/** Reveal-on-hover affordance for the row-level icon buttons. Touch devices
 * have no hover, so there they stay visible — it's the only way to remove
 * sessions and workspaces on the phone. */
const REVEAL =
  "size-5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100";

/** Half-filled circle for the theme toggle — kept from the original icon set. */
function ThemeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path
        d="M8 2.5v11A5.5 5.5 0 008 2.5z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/** Agent commands + plain shell, shared by both new-terminal menus. */
function NewTerminalItems({
  terminalAgents,
  onPick,
}: {
  terminalAgents: TerminalAgent[];
  onPick: (agent: TerminalAgent | null) => void;
}) {
  return (
    <>
      {terminalAgents.map((agent) => (
        <MenuItem key={agent.name} onClick={() => onPick(agent)}>
          <Terminal size={13} />
          {agent.name}
        </MenuItem>
      ))}
      {terminalAgents.length > 0 && <MenuSeparator />}
      <MenuItem onClick={() => onPick(null)}>
        <Terminal size={13} />
        Shell
      </MenuItem>
    </>
  );
}

/** Left sidebar: brand, new-terminal actions, terminals grouped by workspace. */
export function SessionSidebar({
  terminals,
  terminalAgents,
  workspaces,
  activeTerminalId,
  attentionIds,
  onSelectTerminal,
  onNewTerminal,
  onAddWorkspace,
  onRemoveWorkspace,
  onKillTerminal,
  remotePaired,
  onOpenPairing,
  onOpenSettings,
  onToggleTheme,
}: {
  terminals: TerminalMeta[];
  terminalAgents: TerminalAgent[];
  workspaces: WorkspaceMeta[];
  activeTerminalId: string | null;
  /** Sessions an agent flagged for attention while unwatched — show a dot. */
  attentionIds: ReadonlySet<string>;
  onSelectTerminal: (id: string) => void;
  /** null agent = a plain persistent shell; no cwd = the active workspace. */
  onNewTerminal: (agent: TerminalAgent | null, cwd?: string) => void;
  onAddWorkspace: () => void;
  /** Forget a workspace; only offered on groups with no live sessions. */
  onRemoveWorkspace: (cwd: string) => void;
  onKillTerminal: (id: string) => void;
  remotePaired: boolean;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    cwd: string;
  } | null>(null);
  const groups = groupByWorkspace(terminals, workspaces);
  const { width, resize } = usePanelWidth({
    key: "clawdot.sidebar.width",
    fallback: 232,
    min: 176,
    max: 440,
  });

  return (
    <aside
      style={{ "--panel-w": `${width}px` } as React.CSSProperties}
      className="mobile-takeover relative flex w-[min(var(--panel-w),50vw)] shrink-0 flex-col border-r border-border bg-app"
    >
      {/* The takeover class owns the aside's (safe-area) padding on narrow
          viewports, so the cosmetic padding lives one level in. */}
      <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-3 pt-2.5">
        <div className="flex items-center gap-2 px-1.5 pb-3 pt-1">
          <img src={logoUrl} alt="" className="size-3.5 shrink-0" />
          <span className="text-[14px] font-[650] tracking-[-0.01em]">
            Clawdot
          </span>
          <span className="flex-1" />
          <NotificationHub
            terminals={terminals}
            attentionIds={attentionIds}
            onSelect={onSelectTerminal}
          />
          <Button
            size="icon"
            title={remotePaired ? "Remote access (paired)" : "Remote access"}
            aria-label="Remote access"
            onClick={onOpenPairing}
          >
            <Link2 size={15} className={remotePaired ? "text-ok" : undefined} />
          </Button>
          <Button
            size="icon"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Settings size={15} />
          </Button>
          <Button
            size="icon"
            title="Toggle theme"
            aria-label="Toggle theme"
            onClick={onToggleTheme}
          >
            <ThemeIcon size={15} />
          </Button>
        </div>

        <div className="flex flex-col gap-px">
          <button
            className="flex w-full items-center gap-2.25 rounded-sm px-2 py-2.5 text-fg-mid hover:bg-hover hover:text-fg pointer-coarse:py-3 pointer-coarse:text-[14px]"
            onClick={onAddWorkspace}
          >
            <FolderPlus size={15} />
            <span>Add workspace</span>
          </button>
        </div>

        <div className="mt-4.5 flex min-h-0 flex-col gap-px">
          <span className="px-2 text-[11.5px] font-medium text-fg-faint">
            Workspaces
          </span>
          <div className="mt-1.5 flex min-h-0 flex-col gap-1.5 overflow-y-auto">
            {groups.map((ws) => {
              const isCollapsed = collapsed[ws.cwd] ?? false;
              const holdsActive = ws.terminals.some(
                (t) => t.terminalId === activeTerminalId,
              );
              return (
                <Collapsible.Root
                  key={ws.cwd}
                  className="flex flex-col"
                  open={!isCollapsed}
                  onOpenChange={(open) =>
                    setCollapsed((c) => ({ ...c, [ws.cwd]: !open }))
                  }
                >
                  <div
                    className={cn(
                      "group flex items-center gap-1 rounded-sm pr-1 font-[550] text-fg-mid hover:bg-hover hover:text-fg",
                      holdsActive && "text-fg",
                    )}
                    onContextMenu={(e) => {
                      if (ws.terminals.length > 0) return;
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, cwd: ws.cwd });
                    }}
                  >
                    <Collapsible.Trigger
                      className="flex min-w-0 flex-1 items-center gap-1.75 py-1.5 pl-2 pointer-coarse:py-2.5 pointer-coarse:text-[14px]"
                      title={ws.cwd}
                    >
                      {isCollapsed || ws.terminals.length === 0 ? (
                        <Folder size={13} className="shrink-0" />
                      ) : (
                        <FolderOpen size={13} className="shrink-0" />
                      )}
                      <span className="truncate">{basename(ws.cwd)}</span>
                    </Collapsible.Trigger>
                    <Menu
                      trigger={
                        <Button
                          size="icon"
                          className="size-5"
                          title={`New terminal in ${basename(ws.cwd)}`}
                          aria-label={`New terminal in ${basename(ws.cwd)}`}
                        >
                          <Plus size={11} />
                        </Button>
                      }
                    >
                      <NewTerminalItems
                        terminalAgents={terminalAgents}
                        onPick={(agent) => onNewTerminal(agent, ws.cwd)}
                      />
                    </Menu>
                  </div>
                  <Collapsible.Panel className="ml-3.5 flex flex-col gap-px border-l border-border pl-1.75">
                    {ws.terminals.map((t) => (
                      <div
                        key={t.terminalId}
                        className={cn(
                          "group flex items-center rounded-sm pr-1 text-fg-mid hover:bg-hover hover:text-fg",
                          t.terminalId === activeTerminalId &&
                            "bg-active text-fg",
                        )}
                      >
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2.25 py-1.5 pl-2 pr-2.25 pointer-coarse:py-2.5 pointer-coarse:text-[14px]"
                          onClick={() => onSelectTerminal(t.terminalId)}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">
                            {t.title}
                          </span>
                          {attentionIds.has(t.terminalId) &&
                            t.terminalId !== activeTerminalId && (
                              <span
                                className="size-1.75 shrink-0 rounded-full bg-info"
                                title="Needs attention"
                              />
                            )}
                        </button>
                        <Button
                          size="icon"
                          className={REVEAL}
                          title="Kill terminal"
                          aria-label="Kill terminal"
                          onClick={() => onKillTerminal(t.terminalId)}
                        >
                          <X size={11} />
                        </Button>
                      </div>
                    ))}
                  </Collapsible.Panel>
                </Collapsible.Root>
              );
            })}
          </div>
        </div>
      </div>
      <ResizeHandle
        edge="right"
        width={width}
        onResize={resize}
        label="Resize sidebar"
      />
      <BaseMenu.Root
        open={contextMenu !== null}
        onOpenChange={(open) => { if (!open) setContextMenu(null); }}
      >
        <BaseMenu.Portal>
          <BaseMenu.Positioner
            className="z-30"
            anchor={
              contextMenu
                ? {
                    getBoundingClientRect: () =>
                      DOMRect.fromRect({
                        x: contextMenu.x,
                        y: contextMenu.y,
                        width: 0,
                        height: 0,
                      }),
                  }
                : undefined
            }
            sideOffset={2}
            align="start"
          >
            <BaseMenu.Popup className="min-w-44 rounded-md border border-border-strong bg-raised p-1 shadow-panel outline-none pointer-coarse:min-w-52">
              <BaseMenu.Item
                className="flex cursor-pointer items-center gap-2.25 rounded-sm px-2.5 py-2 text-fg-mid outline-none data-highlighted:bg-hover data-highlighted:text-fg pointer-coarse:px-3 pointer-coarse:py-3 pointer-coarse:text-[14px]"
                onClick={() => {
                  if (contextMenu) onRemoveWorkspace(contextMenu.cwd);
                  setContextMenu(null);
                }}
              >
                <Trash2 size={13} />
                Remove workspace
              </BaseMenu.Item>
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
    </aside>
  );
}
