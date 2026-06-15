import { useRef, useState } from "react";
import { cn } from "@/lib/cn";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Panel width persisted in localStorage, clamped to [min, max]. */
export function usePanelWidth({
  key,
  fallback,
  min,
  max,
}: {
  key: string;
  fallback: number;
  min: number;
  max: number;
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0
      ? clamp(stored, min, max)
      : fallback;
  });
  const resize = (next: number) => {
    const clamped = clamp(Math.round(next), min, max);
    setWidth(clamped);
    localStorage.setItem(key, String(clamped));
  };
  return { width, resize };
}

/**
 * Drag handle for resizable side panels: an invisible strip straddling the
 * panel's border that turns into a visible line on hover/drag. Pointer
 * capture keeps the drag alive across iframes (the preview panel) and
 * whatever else the cursor passes over. Hidden on narrow viewports, where
 * panels are full-screen takeovers and have no width to resize.
 */
export function ResizeHandle({
  edge,
  width,
  onResize,
  label,
}: {
  /** Which edge of the panel the handle sits on. */
  edge: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  label: string;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        drag.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startWidth: width,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        onResize(edge === "right" ? d.startWidth + dx : d.startWidth - dx);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) onResize(width + 16);
        else if (e.key === shrink) onResize(width - 16);
        else return;
        e.preventDefault();
      }}
      className={cn(
        "absolute inset-y-0 z-10 w-2.5 cursor-col-resize touch-none max-[700px]:hidden pointer-coarse:w-4",
        edge === "right"
          ? "-right-1.25 pointer-coarse:-right-2"
          : "-left-1.25 pointer-coarse:-left-2",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 hover:after:bg-border-strong focus-visible:after:bg-border-strong",
        dragging && "after:bg-border-strong",
      )}
    />
  );
}
