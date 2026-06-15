import { Bell } from "lucide-react";
import type { TerminalMeta } from "@clawdot/protocol";
import { Button, Menu, MenuItem } from "@/components/ui";

/**
 * In-app notification hub: a bell with an unread dot that drops down the list
 * of sessions an agent flagged for attention while you weren't watching them.
 * Picking one jumps to that session (which clears its dot). This is the
 * foreground counterpart to the push notification — same trigger, but shown
 * inside the app instead of buzzing the device.
 */
export function NotificationHub({
  terminals,
  attentionIds,
  onSelect,
}: {
  terminals: TerminalMeta[];
  attentionIds: ReadonlySet<string>;
  onSelect: (terminalId: string) => void;
}) {
  const pending = terminals.filter((t) => attentionIds.has(t.terminalId));
  return (
    <Menu
      trigger={
        <Button
          size="icon"
          className="relative"
          title="Notifications"
          aria-label={
            pending.length > 0
              ? `Notifications (${pending.length})`
              : "Notifications"
          }
        >
          <Bell size={15} />
          {pending.length > 0 && (
            <span className="absolute right-0.5 top-0.5 size-1.75 rounded-full bg-info ring-2 ring-app" />
          )}
        </Button>
      }
    >
      {pending.length === 0 ? (
        <div className="px-2.5 py-2 text-[13px] text-fg-faint pointer-coarse:px-3 pointer-coarse:py-3">
          No notifications
        </div>
      ) : (
        pending.map((t) => (
          <MenuItem key={t.terminalId} onClick={() => onSelect(t.terminalId)}>
            <span className="size-1.75 shrink-0 rounded-full bg-info" />
            <span className="truncate">{t.title}</span>
          </MenuItem>
        ))
      )}
    </Menu>
  );
}
