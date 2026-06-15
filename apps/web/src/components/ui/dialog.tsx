import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Modal dialog shell: portal, dimmed backdrop, centered panel. Base UI
 * supplies the focus trap and Escape/backdrop dismissal — `onClose` fires
 * for all close paths, including the DialogHeader close button.
 */
/** Panel sizing presets. `lg` is wide enough for a category sidebar. */
const sizes = {
  default:
    "h-[min(540px,calc(100dvh-var(--keyboard-inset,0px)-40px))] w-110",
  lg: "h-[min(640px,calc(100dvh-var(--keyboard-inset,0px)-40px))] w-[min(760px,calc(100vw-40px))]",
} as const;

export function Dialog({
  open,
  onClose,
  size = "default",
  children,
}: {
  open: boolean;
  onClose: () => void;
  size?: keyof typeof sizes;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-20 bg-black/45" />
        {/* Centered in the *visible* viewport: --keyboard-inset shrinks the
            usable height while the on-screen keyboard is up, so focused
            inputs stay reachable without the page scrolling. */}
        <BaseDialog.Popup
          className={`fixed left-1/2 top-[calc((100dvh-var(--keyboard-inset,0px))/2)] z-[21] flex max-w-[calc(100vw-40px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-panel outline-none ${sizes[size]}`}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Title row with optional leading icon and a built-in close button. */
export function DialogHeader({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-3.5 py-3 font-semibold">
      {Icon ? <Icon size={14} /> : null}
      <BaseDialog.Title render={<span />}>{children}</BaseDialog.Title>
      <span className="flex-1" />
      <BaseDialog.Close
        render={<Button size="icon" title="Close" aria-label="Close" />}
      >
        <X size={12} />
      </BaseDialog.Close>
    </header>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-2.5 flex items-center gap-2 border-t border-border px-3.5 py-2.5">
      {children}
    </footer>
  );
}
