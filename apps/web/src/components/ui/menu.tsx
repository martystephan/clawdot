import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";

/** Small dropdown menu anchored to its trigger element. */
export function Menu({
  trigger,
  children,
}: {
  /** Rendered as the trigger via Base UI's `render` prop. */
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-30" sideOffset={4} align="start">
          <BaseMenu.Popup className="min-w-44 rounded-md border border-border-strong bg-raised p-1 shadow-panel outline-none pointer-coarse:min-w-52">
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <BaseMenu.Item
      className="flex cursor-pointer items-center gap-2.25 rounded-sm px-2.5 py-2 text-fg-mid outline-none data-highlighted:bg-hover data-highlighted:text-fg pointer-coarse:px-3 pointer-coarse:py-3 pointer-coarse:text-[14px]"
      onClick={onClick}
    >
      {children}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-border" />;
}
