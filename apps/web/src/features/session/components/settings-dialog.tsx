import { Bell, Plus, Settings, Terminal, X, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { TerminalAgent } from "@clawdot/protocol";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  TextInput,
} from "@/components/ui";

type Category = "agents" | "notifications";

const categories: { id: Category; label: string; icon: LucideIcon }[] = [
  { id: "agents", label: "Terminal agents", icon: Terminal },
  { id: "notifications", label: "Notifications", icon: Bell },
];

/**
 * Settings for the terminal agent list — the commands offered under
 * workspace "+". Stored in the daemon's config.json, so every paired
 * device sees the same agents. Render only while open so the draft
 * re-seeds from the saved list each time. A category sidebar (top tab
 * strip on narrow screens) splits the panes; all drafts persist together
 * on save regardless of which category is showing.
 */
export function SettingsDialog({
  agents,
  notifyOnBell,
  onSave,
  onClose,
}: {
  agents: TerminalAgent[];
  /** Push a notification when an unwatched agent rings the bell. */
  notifyOnBell: boolean;
  onSave: (agents: TerminalAgent[], notifyOnBell: boolean) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<Category>("agents");
  const [draft, setDraft] = useState<TerminalAgent[]>(() =>
    agents.map((a) => ({ ...a })),
  );
  const [notifyDraft, setNotifyDraft] = useState(notifyOnBell);

  const edit = (index: number, patch: Partial<TerminalAgent>) => {
    setDraft((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const remove = (index: number) => {
    setDraft((rows) => rows.filter((_, j) => j !== index));
  };

  const save = () => {
    const cleaned = draft
      .map((a) => ({ name: a.name.trim(), command: a.command.trim() }))
      .filter((a) => a.name && a.command);
    onSave(cleaned, notifyDraft);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} size="lg">
      <DialogHeader icon={Settings}>Settings</DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Category nav: a scrollable tab strip on narrow screens, a
            left rail on wider ones. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-46 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
          {categories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setCategory(id)}
              className={`flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-medium transition-colors sm:w-full ${
                category === id
                  ? "bg-active text-fg"
                  : "text-fg-mid hover:bg-hover"
              }`}
            >
              <Icon size={14} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3">
          {category === "agents" ? (
            <AgentsPane
              draft={draft}
              edit={edit}
              remove={remove}
              add={() =>
                setDraft((rows) => [...rows, { name: "", command: "" }])
              }
            />
          ) : (
            <NotificationsPane
              notifyOnBell={notifyDraft}
              setNotifyOnBell={setNotifyDraft}
            />
          )}
        </div>
      </div>
      <DialogFooter>
        <span className="text-fg-faint">Saved on your machine's daemon.</span>
        <span className="flex-1" />
        <Button variant="primary" onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AgentsPane({
  draft,
  edit,
  remove,
  add,
}: {
  draft: TerminalAgent[];
  edit: (index: number, patch: Partial<TerminalAgent>) => void;
  remove: (index: number) => void;
  add: () => void;
}) {
  return (
    <>
      <div>
        <div className="font-[550]">Terminal agents</div>
        <p className="mt-0.5 text-fg-mid">
          Commands offered in the workspace "+" menu. Each runs in your login
          shell inside a workspace — any CLI coding agent works.
        </p>
      </div>
      <div className="-mb-1 flex items-center gap-2 text-[11.5px] font-medium text-fg-faint">
        <span className="flex-1 basis-2/5 pl-2">Name</span>
        <span className="flex-1 pl-2">Command</span>
        <span className="w-6.5 shrink-0 pointer-coarse:w-9" />
      </div>
      {draft.map((agent, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextInput
            value={agent.name}
            placeholder="Name (e.g. Claude Code)"
            aria-label="Agent name"
            className="basis-2/5 font-ui"
            onChange={(e) => edit(i, { name: e.target.value })}
          />
          <TextInput
            value={agent.command}
            placeholder="Command (e.g. claude)"
            aria-label="Agent command"
            onChange={(e) => edit(i, { command: e.target.value })}
          />
          <Button
            size="icon"
            title="Remove agent"
            aria-label="Remove agent"
            onClick={() => remove(i)}
          >
            <X size={12} />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2 px-2.5 text-fg-mid">
        <Terminal size={13} />
        Shell
      </div>
      <Button className="self-start" onClick={add}>
        <Plus size={12} />
        Add agent
      </Button>
    </>
  );
}

function NotificationsPane({
  notifyOnBell,
  setNotifyOnBell,
}: {
  notifyOnBell: boolean;
  setNotifyOnBell: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      <div>
        <div className="font-[550]">Push notifications</div>
        <p className="mt-0.5 text-fg-mid">
          Get a push on your phone when an agent finishes a turn or asks for
          input while you're not watching that session. Delivered through your
          relay; the relay only sees a generic "needs attention" message, never
          your work. Requires the iOS app and a relay configured for push.
        </p>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-hover">
        <input
          type="checkbox"
          checked={notifyOnBell}
          onChange={(e) => setNotifyOnBell(e.target.checked)}
          className="size-4 accent-accent"
        />
        <span className="font-[550]">Notify on agent bell</span>
      </label>
    </>
  );
}
