import { ArrowUp, ChevronRight, Folder, HardDrive, History, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceMeta } from "@clawdot/protocol";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  TextInput,
} from "@/components/ui";
import type { DirListing } from "@/features/session/hooks/use-daemon";

function basename(path: string): string {
  // Both separators: the daemon may be a Windows machine.
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const DIR_SECTION = "px-2 pb-1 pt-2 text-[11.5px] font-medium text-fg-faint";
const DIR_ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.75 text-fg-mid hover:bg-hover hover:text-fg pointer-coarse:py-2.75 pointer-coarse:text-[14px]";

/**
 * Workspace picker: browse the daemon machine's folders, jump to a recently
 * used workspace, create a folder, and open the current one as a workspace.
 */
export function WorkspaceDialog({
  open,
  listing,
  recents,
  error,
  onNavigate,
  onMakeDir,
  onOpen,
  onClose,
}: {
  open: boolean;
  listing: DirListing | null;
  recents: WorkspaceMeta[];
  error: string | null;
  onNavigate: (path: string) => void;
  onMakeDir: (path: string, name: string) => void;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // A successful mkdir navigates into the new folder — leave creation mode.
  // Closing the dialog resets it too, so it reopens in browse mode.
  useEffect(() => {
    setCreating(false);
    setNewName("");
  }, [listing?.path, open]);

  const submitNewFolder = () => {
    const name = newName.trim();
    if (!name || !listing) return;
    onMakeDir(listing.path, name);
  };

  const parent = listing?.parent ?? null;
  // Windows daemons report drive roots ("C:\", "D:\") — browsing can't cross
  // volumes via "..", so offer them as a switcher. One drive needs no UI.
  const volumes = listing?.volumes ?? [];
  const activeVolume = (v: string) =>
    listing?.path.toUpperCase().startsWith(v.slice(0, 2).toUpperCase()) ?? false;

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader icon={Folder}>Open workspace</DialogHeader>

      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.25">
        {/* rtl + plaintext: ellipsis trims the start of long paths without
            reordering the slashes. */}
        <span
          className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-fg-mid [direction:rtl] [unicode-bidi:plaintext]"
          title={listing?.path}
        >
          {listing?.path ?? "…"}
        </span>
      </div>

      {volumes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2.5 py-1.5">
          <HardDrive size={12} className="mr-0.5 text-fg-faint" />
          {volumes.map((v) => (
            <button
              key={v}
              title={`Switch to drive ${v}`}
              className={`rounded-sm px-2 py-0.75 font-mono text-[11px] pointer-coarse:py-1.5 ${
                activeVolume(v)
                  ? "bg-hover text-fg"
                  : "text-fg-mid hover:bg-hover hover:text-fg"
              }`}
              onClick={() => onNavigate(v)}
            >
              {v.replace(/\\$/, "")}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        {recents.length > 0 && (
          <>
            <div className={DIR_SECTION}>Recent</div>
            {recents.map((w) => (
              <button
                key={w.cwd}
                className={DIR_ITEM}
                title={w.cwd}
                onClick={() => onOpen(w.cwd)}
              >
                <History size={13} />
                <span className="truncate">{basename(w.cwd)}</span>
                <span className="ml-auto max-w-[55%] shrink-0 truncate text-right font-mono text-[10.5px] text-fg-faint [direction:rtl] [unicode-bidi:plaintext]">
                  {w.cwd}
                </span>
              </button>
            ))}
            <div className={DIR_SECTION}>Folders</div>
          </>
        )}
        {parent !== null && (
          <button
            className={DIR_ITEM}
            title="Parent folder"
            onClick={() => onNavigate(parent)}
          >
            <ArrowUp size={13} />
            <span>..</span>
          </button>
        )}
        {listing?.dirs.map((d) => (
          <button
            key={d.path}
            className={DIR_ITEM}
            onClick={() => onNavigate(d.path)}
          >
            <Folder size={13} />
            <span className="truncate">{d.name}</span>
            <ChevronRight size={11} className="ml-auto text-fg-faint" />
          </button>
        ))}
        {listing && listing.dirs.length === 0 && (
          <div className="px-2 py-3.5 text-center text-[11.5px] text-fg-faint">
            No subfolders
          </div>
        )}
      </div>

      {error && (
        <div className="px-3.5 pt-2 text-[11.5px] text-del">{error}</div>
      )}

      <DialogFooter>
        {creating ? (
          <>
            <TextInput
              placeholder="folder name"
              value={newName}
              autoFocus
              spellCheck={false}
              onValueChange={setNewName}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewFolder();
                if (e.key === "Escape") {
                  // Leave creation mode without letting the dialog's own
                  // Escape handling close it.
                  e.stopPropagation();
                  setCreating(false);
                }
              }}
            />
            <Button disabled={!newName.trim()} onClick={submitNewFolder}>
              Create
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setCreating(true)}>
              <Plus size={12} />
              New folder
            </Button>
            <span className="flex-1" />
            <Button
              variant="primary"
              disabled={!listing}
              onClick={() => listing && onOpen(listing.path)}
            >
              Open {listing ? basename(listing.path) : "folder"}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
