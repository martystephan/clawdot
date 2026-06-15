import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "@/lib/cn";

/** Base UI button props with `className` narrowed to a plain string. */
type ButtonBaseProps = Omit<BaseButton.Props, "className"> & {
  className?: string;
};

export type ButtonVariant = "default" | "primary" | "allow" | "reject";
export type ButtonSize = "default" | "icon";

const BTN =
  "inline-flex items-center rounded-sm text-fg-mid hover:bg-hover hover:text-fg " +
  "disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-fg-mid";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary:
    "border-transparent bg-fg text-panel hover:bg-fg hover:text-panel hover:opacity-85",
  allow: "border-ok/50 text-ok hover:bg-ok-bg hover:text-ok",
  reject: "border-del/50 text-del hover:bg-del-bg hover:text-del",
};

/* pointer-coarse: touch devices get native-feeling tap targets (~36-44px)
   without changing the dense desktop layout. */
const SIZE_CLASS: Record<ButtonSize, string> = {
  default:
    "gap-1.5 border border-border-strong px-3 py-1.5 text-[11.5px] font-[550] " +
    "pointer-coarse:gap-2 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-[13px]",
  icon:
    "size-6.5 shrink-0 justify-center text-fg-faint " +
    // Scale the glyph with the touch tap target — CSS size beats the fixed
    // width/height the icons carry as attributes.
    "pointer-coarse:size-9 pointer-coarse:[&_svg]:size-4.5",
};

/** Small action button: bordered by default, a square hover-highlight icon
 * holder with `size="icon"`. */
export function Button({
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonBaseProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <BaseButton
      className={cn(BTN, SIZE_CLASS[size], VARIANT_CLASS[variant], className)}
      {...props}
    />
  );
}

/** Rounded suggestion chip. */
export function Chip({ className, ...props }: ButtonBaseProps) {
  return (
    <BaseButton
      className={cn(
        "rounded-full border border-border px-3.25 py-1.5 text-[11.5px] text-fg-mid hover:border-border-strong hover:bg-hover hover:text-fg pointer-coarse:px-4.5 pointer-coarse:py-2.5 pointer-coarse:text-[13px]",
        className,
      )}
      {...props}
    />
  );
}
