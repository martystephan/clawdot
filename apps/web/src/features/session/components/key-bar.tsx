import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
} from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/cn";

const KEY_CLASS =
  "flex h-8 min-w-10 shrink-0 items-center justify-center rounded-sm border border-border px-2.5 font-mono text-[11px] text-fg-mid active:bg-active pointer-coarse:h-10 pointer-coarse:min-w-12 pointer-coarse:text-[12.5px]";

/** One-shot modifiers armed from the key bar; cleared after the next key. */
export interface KeyMods {
  ctrl: boolean;
  shift: boolean;
}

export const NO_MODS: KeyMods = { ctrl: false, shift: false };

// Characters with a control-code mapping (ctrl+a = 0x01 … ctrl+_ = 0x1f).
const CTRLABLE = /^[a-zA-Z@[\\\]^_]$/;

/** Apply armed modifiers to a chunk of keyboard input bound for the PTY. */
export function applyKeyMods(data: string, mods: KeyMods): string {
  if (mods.ctrl && CTRLABLE.test(data)) {
    return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
  }
  if (mods.shift) {
    if (data === "\r") return "\x1b\r"; // shift+enter: newline in agent CLIs
    if (data === "\t") return "\x1b[Z"; // back-tab (Claude Code mode toggle)
  }
  return data;
}

/** xterm-style CSI arrow sequence with the armed modifiers encoded. */
function arrowSeq(dir: "A" | "B" | "C" | "D", mods: KeyMods): string {
  const mod = 1 + (mods.shift ? 1 : 0) + (mods.ctrl ? 4 : 0);
  return mod === 1 ? `\x1b[${dir}` : `\x1b[1;${mod}${dir}`;
}

function BarKey({
  label,
  active = false,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  // Whether the touch turned into a scroll of the bar rather than a tap.
  const movedRef = useRef(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cn(KEY_CLASS, active && "border-border-strong bg-active text-fg")}
      // Keep focus (and the keyboard) on the terminal's hidden textarea.
      // Desktop browsers honor the cancelled pointerdown; iOS does not — it
      // only suppresses the blur when the *touchend* is cancelled, which
      // also swallows the click, so the key fires from touchend there.
      onPointerDown={(e) => e.preventDefault()}
      onTouchStart={() => {
        movedRef.current = false;
      }}
      onTouchMove={() => {
        movedRef.current = true;
      }}
      onTouchEnd={(e) => {
        if (movedRef.current) return;
        e.preventDefault();
        onPress();
      }}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

/**
 * Terminal helper keys the soft keyboard lacks, shown above it while it is
 * open. ctrl/shift arm as one-shot modifiers: they apply to the next key —
 * tapped here or typed on the keyboard — then clear, like mobile terminal
 * apps do.
 */
export function KeyBar({
  mods,
  onModsChange,
  onKey,
}: {
  mods: KeyMods;
  onModsChange: (mods: KeyMods) => void;
  /** Send an already-encoded sequence to the PTY (modifiers clear after). */
  onKey: (data: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-panel px-2.5 py-1.5">
      {/* Only the keys scroll on tight screens — the dismiss chevron stays
          pinned at the right edge. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <BarKey label="Escape" onPress={() => onKey("\x1b")}>
          esc
        </BarKey>
        <BarKey
          label="Tab"
          onPress={() => onKey(mods.shift ? "\x1b[Z" : "\t")}
        >
          tab
        </BarKey>
        <BarKey
          label="Control"
          active={mods.ctrl}
          onPress={() => onModsChange({ ...mods, ctrl: !mods.ctrl })}
        >
          ctrl
        </BarKey>
        <BarKey
          label="Shift"
          active={mods.shift}
          onPress={() => onModsChange({ ...mods, shift: !mods.shift })}
        >
          shift
        </BarKey>
        <span className="flex-1" />
        <BarKey label="Arrow left" onPress={() => onKey(arrowSeq("D", mods))}>
          <ArrowLeft size={13} />
        </BarKey>
        <BarKey label="Arrow down" onPress={() => onKey(arrowSeq("B", mods))}>
          <ArrowDown size={13} />
        </BarKey>
        <BarKey label="Arrow up" onPress={() => onKey(arrowSeq("A", mods))}>
          <ArrowUp size={13} />
        </BarKey>
        <BarKey label="Arrow right" onPress={() => onKey(arrowSeq("C", mods))}>
          <ArrowRight size={13} />
        </BarKey>
      </div>
      {/* Deliberately not a BarKey: those suppress the focus loss, and this
          button's whole point is to blur the terminal so the keyboard (and
          with it this bar) goes away. */}
      <button
        type="button"
        aria-label="Hide keyboard"
        title="Hide keyboard"
        className={KEY_CLASS}
        onClick={() => {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement) focused.blur();
        }}
      >
        <ChevronDown size={14} />
      </button>
    </div>
  );
}
