import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  Frame,
  Globe,
  Hand,
  Keyboard,
  Maximize,
  Maximize2,
  Minimize,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserInput } from "@clawdot/protocol";
import { isNativeShell } from "@/config";
import {
  Button,
  ResizeHandle,
  TextInput,
  usePanelWidth,
} from "@/components/ui";
import type { BrowserClient } from "@/features/preview/browser-client";
import { cn } from "@/lib/cn";

/** Per-session port memory: each terminal session remembers its own preview
 *  target (the panel is keyed by session, so switching swaps the whole panel). */
const portKey = (storageKey: string) => `clawdot.preview.port.${storageKey}`;

/** CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
function modifiers(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  );
}

const MOUSE_BUTTON = ["left", "middle", "right"] as const;
/** A touch drag shorter than this counts as a tap (a click), not a scroll. */
const TAP_SLOP_PX = 6;

/** Does the remote page currently have a text-editable element focused? Used
 *  after a tap to decide whether to raise the soft keyboard. */
const IS_EDITABLE_EXPR = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
})()`;

/** Height of the floating window's titlebar (the drag handle) in canvas mode. */
const TITLEBAR_H = 26;
/** Window-size clamp (CSS px) for the freeform canvas. */
const MIN_WIN = 200;
const MAX_WIN = 4000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Device presets for the freeform canvas window. */
const SIZE_PRESETS = [
  { label: "Phone", Icon: Smartphone, width: 390, height: 844 },
  { label: "Tablet", Icon: Tablet, width: 834, height: 1112 },
  { label: "Desktop", Icon: Monitor, width: 1280, height: 800 },
] as const;

/**
 * Resolve what the user typed in the address bar into a full URL, the way a
 * browser's omnibox does: an absolute URL passes through; a bare integer is a
 * loopback dev-server port; anything else is treated as a scheme-less URL
 * (example.com, 192.168.0.5:8080/x). Returns null if nothing parses.
 */
function resolveUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      return new URL(v).href;
    } catch {
      return null;
    }
  }
  if (/^\d+$/.test(v)) {
    const port = Number(v);
    return port >= 1 && port <= 65535 ? `http://localhost:${port}/` : null;
  }
  try {
    return new URL(`http://${v}`).href;
  } catch {
    return null;
  }
}

/**
 * Right-side web preview: a live view of a REAL headless browser tab running
 * on the daemon's machine, streamed here as JPEG frames over the encrypted
 * connection (see features/preview/browser-client.ts and the daemon's
 * browser.ts). The page executes server-side, so the previewed site sees the
 * daemon host — not this device — with no service worker, CORS, or subdomain
 * setup. Pointer/keyboard input is forwarded back; the console drawer
 * evaluates JS against the tab's live DOM.
 *
 * The tab lives in a persistent per-session "view" (keyed by storageKey), so
 * switching terminal sessions backgrounds it (pauses streaming) instead of
 * closing it — switching back resumes the same page instantly.
 */
export function PreviewPanel({
  storageKey,
  browser,
  onClose,
}: {
  /** Namespaces the view + remembered target — one per terminal session. */
  storageKey: string;
  browser: BrowserClient;
  onClose: () => void;
}) {
  const view = useMemo(() => browser.view(storageKey), [browser, storageKey]);

  // The address-bar text. Editable; syncs to the live URL on navigation unless
  // the user is mid-edit. Seeded from the open tab or the last typed target.
  const [input, setInput] = useState(
    () => view.state().url || localStorage.getItem(portKey(storageKey)) || "",
  );
  const editingRef = useRef(false);
  const [active, setActive] = useState(() => view.state().open);
  const [address, setAddress] = useState(() => view.state().url);
  const [error, setError] = useState<string | null>(() => view.state().error);
  const [canGoBack, setCanGoBack] = useState(() => view.state().canGoBack);
  const [canGoForward, setCanGoForward] = useState(
    () => view.state().canGoForward,
  );
  const [consoleOpen, setConsoleOpen] = useState(false);

  // Freeform canvas mode: the browser becomes a draggable, resizable window
  // floating in a pannable/zoomable 2D space. `winSize` is the window's logical
  // size (CSS px) — which IS the daemon's emulated viewport, so resizing it
  // previews the page at different screen sizes. `pan`/`zoom` move the space.
  const [mode, setMode] = useState<"fit" | "canvas">("fit");
  const [winSize, setWinSize] = useState({ width: 390, height: 844 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  // Navigate (input-lock) mode: stop forwarding pointer/keyboard to the remote
  // page so a one-finger drag pans the stage and pinch/wheel zooms instead —
  // makes arranging the window on a touchscreen far easier. Canvas mode only.
  const [locked, setLocked] = useState(false);

  // Maximize: expand the side panel to cover the whole app viewport (a CSS
  // overlay, not the OS Fullscreen API). Pointless inside the native mobile
  // shell, where the panel already takes over the screen, so it's gated out.
  const canMaximize = !isNativeShell();
  const [maximized, setMaximized] = useState(false);

  // Fit-mode aspect tracking. The daemon drives the emulated viewport to match
  // the panel, but the first frames after open (or after the panel resizes —
  // e.g. a mobile keyboard dismissing) arrive at the OLD aspect. Rather than
  // stretch the bitmap to fill the panel (visibly distorted), we size the
  // canvas to the frame's real aspect and centre it, so a transient mismatch
  // letterboxes instead of warping. Input stays exact: toViewport measures the
  // canvas's own rect, which now matches the drawn image.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [frameAspect, setFrameAspect] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Off-screen editable element whose focus raises the mobile OS keyboard (see
  // the soft-keyboard bridge below). `keyboardOpen` tracks whether it's focused.
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // The emulated viewport (CSS px) — used to map input back to page coords.
  const viewportRef = useRef({ width: 1, height: 1 });
  const touchRef = useRef<{
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const measure = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect?.width ?? 1)),
      height: Math.max(1, Math.round(rect?.height ?? 1)),
      dpr: Math.min(2, window.devicePixelRatio || 1),
    };
  };

  const drawFrame = useCallback((data: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.width) canvas.width = img.width;
      if (canvas.height !== img.height) canvas.height = img.height;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${data}`;
  }, []);

  // Attach to the view: replays the current frame/state immediately (instant
  // repaint when switching back to an already-open session) and resumes the
  // daemon's stream while mounted. Detaching pauses it without closing the tab.
  useEffect(() => {
    const unsubscribe = view.subscribe({
      onFrame: (frame) => {
        viewportRef.current = {
          width: frame.meta.deviceWidth || viewportRef.current.width,
          height: frame.meta.deviceHeight || viewportRef.current.height,
        };
        if (frame.meta.deviceWidth && frame.meta.deviceHeight)
          setFrameAspect(frame.meta.deviceWidth / frame.meta.deviceHeight);
        drawFrame(frame.data);
      },
      onState: (state) => {
        setActive(state.open);
        setAddress(state.url);
        setError(state.error);
        setCanGoBack(state.canGoBack);
        setCanGoForward(state.canGoForward);
        // Reflect redirects/link clicks in the bar — but don't clobber the user
        // while they're typing a new address.
        if (state.url && !editingRef.current) setInput(state.url);
      },
    });
    return unsubscribe;
  }, [view, drawFrame]);

  // Keep the emulated viewport in step. In fit mode it tracks the panel size via
  // a ResizeObserver; in canvas mode the window's chosen size IS the viewport,
  // so a change to `winSize` (resize handles / presets) drives a debounced
  // resize — the daemon re-renders the page at that screen size.
  useEffect(() => {
    if (mode === "canvas") {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      viewportRef.current = { width: winSize.width, height: winSize.height };
      const timer = setTimeout(
        () => view.resize(winSize.width, winSize.height, dpr),
        120,
      );
      return () => clearTimeout(timer);
    }
    const el = containerRef.current;
    if (!el) return;
    // Seed the panel size now so fit sizing has a box before the first resize.
    const seed = measure();
    setContainerSize({ width: seed.width, height: seed.height });
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { width, height, dpr } = measure();
        setContainerSize({ width, height });
        viewportRef.current = { width, height };
        view.resize(width, height, dpr);
      }, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [view, mode, winSize]);

  // Fit-mode display box: the largest rect of the frame's aspect ratio that
  // fits inside the panel (object-contain, but sizing the element itself so
  // input mapping stays exact). Null until we know both sizes — fall back to
  // filling the panel for that first paint.
  const fitCanvas = useMemo(() => {
    if (
      mode !== "fit" ||
      !frameAspect ||
      !containerSize.width ||
      !containerSize.height
    )
      return null;
    const panelAspect = containerSize.width / containerSize.height;
    if (frameAspect > panelAspect)
      return {
        width: containerSize.width,
        height: Math.round(containerSize.width / frameAspect),
      };
    return {
      width: Math.round(containerSize.height * frameAspect),
      height: containerSize.height,
    };
  }, [mode, frameAspect, containerSize]);

  // Address-bar submit: navigate the open tab, or open one if none yet.
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const url = resolveUrl(input);
    if (!url) return;
    localStorage.setItem(portKey(storageKey), input.trim());
    editingRef.current = false;
    setError(null);
    if (active) {
      view.navigate(url);
    } else {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width, height } = mode === "canvas" ? winSize : measure();
      viewportRef.current = { width, height };
      setActive(true);
      view.open({ url, width, height, dpr });
    }
    (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
  };

  const closePreview = () => {
    view.close();
    onClose();
  };

  const toViewport = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const vp = viewportRef.current;
    return {
      x: ((clientX - rect.left) / rect.width) * vp.width,
      y: ((clientY - rect.top) / rect.height) * vp.height,
    };
  };

  const send = (event: BrowserInput) => view.input(event);

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toViewport(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === "mouse") {
      // Focus the sink so a hardware keyboard reaches the page (no soft keyboard
      // is raised without touch). Touch defers — a stray focus would pop the OS
      // keyboard on every tap; onPointerUp raises it only on editable taps.
      openKeyboard();
      send({
        kind: "mouse",
        type: "mousePressed",
        x,
        y,
        button: MOUSE_BUTTON[e.button] ?? "left",
        clickCount: 1,
        modifiers: modifiers(e),
      });
    } else {
      // Touch/pen: defer — a drag scrolls, a stationary release taps.
      touchRef.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") {
      if (e.buttons === 0 && e.movementX === 0 && e.movementY === 0) return;
      const { x, y } = toViewport(e.clientX, e.clientY);
      send({
        kind: "mouse",
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: e.buttons,
        modifiers: modifiers(e),
      });
      return;
    }
    const t = touchRef.current;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (
      Math.abs(e.clientX - t.startX) > TAP_SLOP_PX ||
      Math.abs(e.clientY - t.startY) > TAP_SLOP_PX
    ) {
      t.moved = true;
    }
    const { x, y } = toViewport(e.clientX, e.clientY);
    // Dragging the content down scrolls the page up — invert into wheel deltas.
    send({ kind: "wheel", x, y, deltaX: -dx, deltaY: -dy });
    t.x = e.clientX;
    t.y = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const { x, y } = toViewport(e.clientX, e.clientY);
    if (e.pointerType === "mouse") {
      send({
        kind: "mouse",
        type: "mouseReleased",
        x,
        y,
        button: MOUSE_BUTTON[e.button] ?? "left",
        clickCount: 1,
        modifiers: modifiers(e),
      });
      return;
    }
    const t = touchRef.current;
    touchRef.current = null;
    if (t && !t.moved) {
      send({
        kind: "mouse",
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      send({
        kind: "mouse",
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      // Raise or dismiss the soft keyboard based on whether the tap focused an
      // editable element in the remote page. The eval round-trip leaves the
      // user gesture, so the focus() lands within gesture only on lenient
      // engines (Android); on iOS the keyboard toolbar button is the reliable
      // path. Dismissing (blur) works regardless of gesture.
      view
        .eval(IS_EDITABLE_EXPR)
        .then((editable) => (editable ? openKeyboard() : closeKeyboard()))
        .catch(() => {});
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = toViewport(e.clientX, e.clientY);
    send({
      kind: "wheel",
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiers(e),
    });
  };

  // Send a whole string straight into the focused remote element (CDP
  // Input.insertText), used for paste so multi-char content isn't replayed
  // keystroke-by-keystroke.
  const sendText = (text: string) => {
    if (text) send({ kind: "text", text });
  };

  // Toolbar fallback (mobile has no Cmd/Ctrl+V): read the device clipboard and
  // insert it. Needs a user gesture + clipboard-read permission; ignore denial.
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      sendText(text);
    } catch {
      // Clipboard read blocked (permission/insecure context) — nothing to do.
    }
  };

  // --- Soft-keyboard bridge -------------------------------------------------
  // A streamed <canvas> is not an editable element, so tapping a text field in
  // the remote page never raises the device's on-screen keyboard, and iOS soft
  // keyboards don't emit usable keydown events for printable characters (they
  // report keyCode 229). Keyboard input is therefore routed through an
  // off-screen <textarea> "sink": focusing it summons the OS keyboard, typed
  // text arrives as input/composition events (forwarded verbatim via CDP
  // insertText), and control keys (Backspace/Enter/arrows/shortcuts) still come
  // through keydown. Focus must happen inside a user gesture or iOS ignores it —
  // hence the toolbar button and the synchronous focus on a mouse press.
  const openKeyboard = () => keyboardRef.current?.focus({ preventScroll: true });
  const closeKeyboard = () => keyboardRef.current?.blur();

  // Forward whatever the OS keyboard inserted, then reset the sink so the next
  // input event starts clean (and Backspace on an empty field still keydowns).
  const onKbInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return; // mid-IME: wait for compositionend
    const el = e.currentTarget;
    if (el.value) {
      sendText(el.value);
      el.value = "";
    }
  };
  const onKbCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const el = e.currentTarget;
    if (el.value) sendText(el.value);
    el.value = "";
  };

  const onKey = (e: React.KeyboardEvent, type: "keyDown" | "keyUp") => {
    // iOS reports printable keys as keyCode 229 / "Unidentified" — those are
    // delivered by the input event instead; ignore them here.
    if (e.keyCode === 229 || e.key === "Unidentified") return;
    // Single printable characters also ride the input event; forwarding them as
    // keystrokes too would double-type. Only non-printable keys go through here
    // (preventDefault stops the sink from mutating, so no stray input event).
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) return;
    // Let the native paste event handle Cmd/Ctrl+V: don't preventDefault (it can
    // suppress the paste event) and don't forward it as a keystroke either; the
    // pasted text flows through the sink's input event.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    send({
      kind: "key",
      type,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      modifiers: modifiers(e),
    });
  };

  // --- Freeform canvas (pan / zoom / resize the window) ---

  // Centre the window in the stage and pick a zoom that fits it with padding.
  const fitView = useCallback((size: { width: number; height: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pad = 56;
    const frameH = size.height + TITLEBAR_H;
    const z = clamp(
      Math.min((rect.width - pad) / size.width, (rect.height - pad) / frameH),
      MIN_ZOOM,
      1,
    );
    setZoom(z);
    setPan({
      x: (rect.width - size.width * z) / 2,
      y: (rect.height - frameH * z) / 2,
    });
  }, []);

  const toggleMode = () => {
    if (mode === "canvas") {
      setMode("fit");
      setLocked(false);
      return;
    }
    // Seed the window from the current viewport so the layout doesn't jump.
    const vp = viewportRef.current;
    const seed =
      active && vp.width > 1
        ? { width: Math.round(vp.width), height: Math.round(vp.height) }
        : { width: 390, height: 844 };
    setWinSize(seed);
    setMode("canvas");
    fitView(seed);
  };

  const applyPreset = (size: { width: number; height: number }) => {
    setWinSize(size);
    fitView(size);
  };

  const rotateWindow = () => {
    const swapped = { width: winSize.height, height: winSize.width };
    setWinSize(swapped);
    fitView(swapped);
  };

  // Drag empty space (or the titlebar) to pan the whole stage.
  const startPan = (e: React.PointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    const origin = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    const onMove = (ev: PointerEvent) =>
      setPan({
        x: origin.px + (ev.clientX - origin.x),
        y: origin.py + (ev.clientY - origin.y),
      });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Zoom toward the cursor (ctrl/⌘+wheel or trackpad pinch over empty space).
  const onStageWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const next = clamp(zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
    setPan({
      x: cx - ((cx - pan.x) / zoom) * next,
      y: cy - ((cy - pan.y) / zoom) * next,
    });
    setZoom(next);
  };

  // Zoom buttons keep the stage centre fixed.
  const zoomByButton = (factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (rect) {
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      setPan({
        x: cx - ((cx - pan.x) / zoom) * next,
        y: cy - ((cy - pan.y) / zoom) * next,
      });
    }
    setZoom(next);
  };

  // Drag a grip to resize the window (anchored top-left). Deltas are divided by
  // the current zoom so the edge tracks the pointer 1:1 on screen.
  const startResize = (dir: "e" | "s" | "se") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const origin = {
      x: e.clientX,
      y: e.clientY,
      w: winSize.width,
      h: winSize.height,
      z: zoom,
    };
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - origin.x) / origin.z;
      const dy = (ev.clientY - origin.y) / origin.z;
      setWinSize({
        width:
          dir === "s"
            ? origin.w
            : clamp(Math.round(origin.w + dx), MIN_WIN, MAX_WIN),
        height:
          dir === "e"
            ? origin.h
            : clamp(Math.round(origin.h + dy), MIN_WIN, MAX_WIN),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Shared with the terminal panel — they occupy the same edge, one at a time.
  const { width, resize } = usePanelWidth({
    key: "clawdot.panel.width",
    fallback: 384,
    min: 264,
    max: 800,
  });

  return (
    <aside
      style={{ "--panel-w": `${width}px` } as React.CSSProperties}
      className={cn(
        "relative flex flex-col bg-app",
        maximized
          ? "fixed inset-0 z-50 w-full"
          : "mobile-takeover w-[min(var(--panel-w),70vw)] shrink-0 border-l border-border",
      )}
    >
      <div className="flex min-h-10.5 items-center gap-2.25 border-b border-border px-3 py-2.25">
        <Globe size={14} className="text-fg-mid" />
        <span className="font-[550]">Preview</span>
        <span className="flex-1" />
        {active && (
          <>
            <Button
              size="icon"
              title={
                mode === "canvas"
                  ? "Fit view (exit freeform canvas)"
                  : "Freeform canvas (resize & arrange the window)"
              }
              aria-label="Toggle freeform canvas"
              aria-pressed={mode === "canvas"}
              onClick={toggleMode}
            >
              {mode === "canvas" ? (
                <Maximize2 size={13} />
              ) : (
                <Frame size={13} />
              )}
            </Button>
            <Button
              size="icon"
              title={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
              aria-label="Toggle keyboard"
              aria-pressed={keyboardOpen}
              className={cn(keyboardOpen ? "bg-hover text-fg" : undefined)}
              onClick={() => (keyboardOpen ? closeKeyboard() : openKeyboard())}
            >
              <Keyboard size={13} />
            </Button>
            <Button
              size="icon"
              title="Console (evaluate JS in the page)"
              aria-label="Toggle console"
              onClick={() => setConsoleOpen((v) => !v)}
            >
              <Braces size={13} />
            </Button>
            <Button
              size="icon"
              title="Paste clipboard into the page"
              aria-label="Paste into page"
              onClick={pasteFromClipboard}
            >
              <ClipboardPaste size={13} />
            </Button>
            <Button
              size="icon"
              title="Open in new tab"
              aria-label="Open in new tab"
              disabled={!address}
              onClick={() => address && window.open(address, "_blank")}
            >
              <ExternalLink size={13} />
            </Button>
          </>
        )}
        {canMaximize && (
          <Button
            size="icon"
            title={maximized ? "Restore panel" : "Maximize panel"}
            aria-label={maximized ? "Restore panel" : "Maximize panel"}
            aria-pressed={maximized}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? <Minimize size={13} /> : <Maximize size={13} />}
          </Button>
        )}
        <Button
          size="icon"
          title="Close preview"
          aria-label="Close preview"
          onClick={closePreview}
        >
          <X size={13} />
        </Button>
      </div>

      <form
        className="flex items-center gap-1.5 border-b border-border px-2 py-2"
        onSubmit={go}
      >
        {active && (
          <>
            <Button
              size="icon"
              title="Back"
              aria-label="Back"
              disabled={!canGoBack}
              onClick={() => view.back()}
            >
              <ChevronLeft size={15} />
            </Button>
            <Button
              size="icon"
              title="Forward"
              aria-label="Forward"
              disabled={!canGoForward}
              onClick={() => view.forward()}
            >
              <ChevronRight size={15} />
            </Button>
            <Button
              size="icon"
              title="Reload"
              aria-label="Reload"
              onClick={() => view.reload()}
            >
              <RotateCw size={13} />
            </Button>
          </>
        )}
        <TextInput
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={(e) => {
            editingRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            editingRef.current = false;
            // Abandoned edit reverts to the live address.
            if (active && address) setInput(address);
          }}
          placeholder="5173 or https://…"
          aria-label="Address"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button type="submit">{active ? "Go" : "Open"}</Button>
      </form>

      <div
        ref={containerRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden",
          mode === "canvas" ? "bg-inset" : "bg-white",
        )}
      >
        {/* Off-screen soft-keyboard sink (see the bridge above). Kept on-screen
            but invisible and non-interactive: iOS won't raise the keyboard for
            a display:none / out-of-viewport element, and pointer-events-none
            stops it from stealing taps meant for the canvas. */}
        <textarea
          ref={keyboardRef}
          onInput={onKbInput}
          onKeyDown={(e) => onKey(e, "keyDown")}
          onKeyUp={(e) => onKey(e, "keyUp")}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={onKbCompositionEnd}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => setKeyboardOpen(false)}
          aria-hidden
          tabIndex={-1}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="pointer-events-none absolute left-0 top-0 z-40 size-px resize-none border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
        />

        {/* The pannable 2D space: drag empty area to pan, wheel/pinch to zoom.
            It sits behind the (pointer-events-none) stage, which lets gestures
            on empty space reach it while the window frame stays interactive. */}
        {mode === "canvas" && (
          <div
            className="absolute inset-0 z-0 cursor-grab bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] bg-size-[24px_24px] active:cursor-grabbing"
            onPointerDown={startPan}
            onWheel={onStageWheel}
          />
        )}

        <div
          className={cn(
            mode === "canvas"
              ? "pointer-events-none absolute left-0 top-0 z-10 origin-top-left"
              : "absolute inset-0",
          )}
          style={
            mode === "canvas"
              ? {
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }
              : undefined
          }
        >
          <div
            className={cn(
              mode === "canvas"
                ? "pointer-events-auto absolute left-0 top-0 overflow-hidden rounded-lg border border-border-strong bg-white shadow-2xl"
                : "flex h-full w-full items-center justify-center",
              mode === "canvas" && locked && "cursor-grab active:cursor-grabbing",
            )}
            // When locked, the page-input layer (canvas) is inert, so drags on
            // the window pan the stage and wheel/pinch zooms — same as the
            // empty-space backdrop, but works over the window too.
            onPointerDown={mode === "canvas" && locked ? startPan : undefined}
            onWheel={mode === "canvas" && locked ? onStageWheel : undefined}
            style={
              mode === "canvas"
                ? { width: winSize.width, height: winSize.height + TITLEBAR_H }
                : undefined
            }
          >
            {mode === "canvas" && (
              <div
                className="flex cursor-grab select-none items-center justify-center border-b border-border bg-app text-[11px] font-[550] text-fg-mid active:cursor-grabbing"
                style={{ height: TITLEBAR_H }}
                onPointerDown={startPan}
                title="Drag to move the window"
              >
                {winSize.width} × {winSize.height}
              </div>
            )}
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
              className={cn(
                "block outline-none",
                mode === "canvas" && locked && "pointer-events-none",
              )}
              style={
                mode === "canvas"
                  ? {
                      width: winSize.width,
                      height: winSize.height,
                      display: active ? "block" : "none",
                    }
                  : {
                      display: active ? "block" : "none",
                      // Sized to the frame's aspect (centred by the flex
                      // wrapper); falls back to filling the panel until the
                      // first frame tells us the aspect.
                      ...(fitCanvas
                        ? { width: fitCanvas.width, height: fitCanvas.height }
                        : { width: "100%", height: "100%" }),
                    }
              }
            />
            {mode === "canvas" && (
              <>
                <div
                  onPointerDown={startResize("e")}
                  className="absolute bottom-2.5 right-0 top-7 z-10 w-2 cursor-ew-resize"
                  title="Resize width"
                />
                <div
                  onPointerDown={startResize("s")}
                  className="absolute bottom-0 left-0 right-2.5 z-10 h-2 cursor-ns-resize"
                  title="Resize height"
                />
                <div
                  onPointerDown={startResize("se")}
                  className="absolute bottom-0 right-0 z-20 size-3.5 cursor-nwse-resize rounded-tl-sm border-b-2 border-r-2 border-border-strong"
                  title="Resize"
                />
              </>
            )}
          </div>
        </div>

        {!active && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 bg-app px-6 text-center">
            <Globe size={18} className="text-fg-faint" />
            <p className="text-[12.5px] text-fg-mid">
              Enter the port of a dev server on the daemon's machine. It opens
              in a real browser there and streams here — the site sees the
              daemon, not this device.
            </p>
          </div>
        )}
        {error && (
          <div className="absolute inset-x-0 bottom-0 z-30 bg-app/90 px-3 py-1.5 text-[11px] text-fg-mid">
            {error}
          </div>
        )}

        {/* Freeform-canvas controls: device presets + zoom. */}
        {mode === "canvas" && active && (
          <div className="absolute bottom-2.5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-border bg-app/95 px-1.5 py-1 shadow-lg backdrop-blur">
            <Button
              size="icon"
              title={
                locked
                  ? "Page input locked — tap to interact with the page again"
                  : "Navigate (lock page input — drag to pan, pinch/wheel to zoom)"
              }
              aria-label="Toggle navigate mode"
              aria-pressed={locked}
              className={cn(locked ? "bg-hover text-fg" : undefined)}
              onClick={() => setLocked((v) => !v)}
            >
              <Hand size={13} />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border" />
            {SIZE_PRESETS.map((p) => (
              <Button
                key={p.label}
                size="icon"
                title={`${p.label} (${p.width} × ${p.height})`}
                aria-label={p.label}
                aria-pressed={
                  winSize.width === p.width && winSize.height === p.height
                }
                className={cn(
                  (winSize.width === p.width && winSize.height === p.height) ||
                    (winSize.width === p.height && winSize.height === p.width)
                    ? "bg-hover text-fg"
                    : undefined,
                )}
                onClick={() =>
                  applyPreset({ width: p.width, height: p.height })
                }
              >
                <p.Icon size={13} />
              </Button>
            ))}
            <button
              type="button"
              title="Rotate (swap width / height)"
              aria-label="Rotate window"
              onClick={rotateWindow}
              className="mx-0.5 rounded-sm px-1.5 py-1 font-mono text-[10.5px] text-fg-mid hover:bg-hover hover:text-fg pointer-coarse:px-2 pointer-coarse:py-1.5 pointer-coarse:text-[12px]"
            >
              {winSize.height > winSize.width ? "⤢" : "⤡"}
            </button>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <Button
              size="icon"
              title="Zoom out"
              aria-label="Zoom out"
              onClick={() => zoomByButton(0.8)}
            >
              <Minus size={13} />
            </Button>
            <button
              type="button"
              title="Fit window to view"
              aria-label="Fit window to view"
              onClick={() => fitView(winSize)}
              className="min-w-10 rounded-sm px-1 py-1 text-center text-[10.5px] tabular-nums text-fg-mid hover:bg-hover hover:text-fg pointer-coarse:text-[12px]"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              size="icon"
              title="Zoom in"
              aria-label="Zoom in"
              onClick={() => zoomByButton(1.25)}
            >
              <Plus size={13} />
            </Button>
          </div>
        )}
      </div>
      {active && consoleOpen && (
        <ConsoleDrawer evaluate={(expr) => view.eval(expr)} />
      )}
      {!maximized && (
        <ResizeHandle
          edge="left"
          width={width}
          onResize={resize}
          label="Resize preview panel"
        />
      )}
    </aside>
  );
}

/** A tiny REPL against the tab's live DOM (proof that DOM access works). */
function ConsoleDrawer({
  evaluate,
}: {
  evaluate: (expr: string) => Promise<unknown>;
}) {
  const [expr, setExpr] = useState("document.title");
  const [out, setOut] = useState<string>("");

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const value = await evaluate(expr);
      setOut(
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      );
    } catch (err) {
      setOut(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex max-h-56 shrink-0 flex-col border-t border-border">
      <form className="flex items-center gap-2 px-3 py-2" onSubmit={run}>
        <span className="shrink-0 font-mono text-[11.5px] text-fg-faint">
          JS
        </span>
        <TextInput
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="document.querySelectorAll('a').length"
          aria-label="JS expression"
          className="font-mono"
        />
        <Button type="submit">Run</Button>
      </form>
      {out && (
        <pre className="min-h-0 flex-1 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] text-fg-mid">
          {out}
        </pre>
      )}
    </div>
  );
}
