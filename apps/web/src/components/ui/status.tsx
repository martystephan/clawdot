import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type StatusKind = "idle" | "live" | "warn" | "err";

const DOT_KIND: Record<StatusKind, string> = {
  idle: "bg-fg-faint opacity-50",
  live: "bg-live shadow-[0_0_0_3px_color-mix(in_oklab,var(--live)_25%,transparent)]",
  warn: "bg-warn",
  err: "bg-del",
};

/** Small colored presence dot (session/agent/connection state). */
export function StatusDot({
  kind = "idle",
  className,
}: {
  kind?: StatusKind;
  className?: string;
}) {
  return (
    <span
      className={cn("size-1.75 shrink-0 rounded-full", DOT_KIND[kind], className)}
    />
  );
}

/** Spinning ring shown while the agent is working. */
export function Spinner() {
  return (
    <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-faint border-t-fg [animation-duration:0.9s]" />
  );
}

/** Bordered monospace pill, e.g. the workspace name in the chat header. */
export function Pill({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-1.75 py-px font-mono text-[10.5px] text-fg-mid"
      title={title}
    >
      {children}
    </span>
  );
}
