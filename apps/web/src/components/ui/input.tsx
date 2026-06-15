import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

/** Single-line text input on the inset background. */
export function TextInput({
  className,
  ...props
}: Omit<BaseInput.Props, "className"> & { className?: string }) {
  return (
    <BaseInput
      className={cn(
        "w-full min-w-0 flex-1 rounded-sm border border-border bg-inset px-2 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-fg-faint focus:border-fg-faint pointer-coarse:px-2.5 pointer-coarse:py-2.5 pointer-coarse:text-[13px]",
        className,
      )}
      {...props}
    />
  );
}
