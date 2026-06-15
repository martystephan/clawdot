import { useSyncExternalStore } from "react";

/**
 * Height (px) of the on-screen keyboard overlapping the layout viewport — 0
 * when closed and always 0 on desktop. Derived from the visualViewport API
 * (the only signal WKWebView/Chrome give for the soft keyboard). The value
 * is also published as `--keyboard-inset` on <html>; body padding and the
 * dialog popup use it (styles.css, ui/dialog.tsx) so the whole app re-lays
 * itself out above the keyboard.
 */

/** Insets past this are a real on-screen keyboard, not browser-UI jitter. */
export const KEYBOARD_MIN_PX = 100;

let inset = 0;
const listeners = new Set<() => void>();

function update() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Pinch zoom also shrinks the visual viewport — that's not a keyboard.
  const zoomed = vv.scale > 1.05;
  const next = zoomed
    ? 0
    : Math.max(0, Math.round(window.innerHeight - vv.height));
  // While the keyboard is up the page must not pan: the app resizes to the
  // visible area instead, so any scroll offset iOS introduces (revealing a
  // focused field, or a stray drag) would only hide content.
  if (next > 0 && (vv.offsetTop > 0 || window.scrollY > 0)) {
    window.scrollTo(0, 0);
  }
  if (next === inset) return;
  inset = next;
  document.documentElement.style.setProperty("--keyboard-inset", `${next}px`);
  for (const notify of listeners) notify();
}

// Eager, not subscriber-gated: the CSS variable drives body padding and
// dialog layout even when no React consumer is mounted (the terminal views
// that use the hook are lazy-loaded).
if (typeof window !== "undefined" && window.visualViewport) {
  window.visualViewport.addEventListener("resize", update);
  window.visualViewport.addEventListener("scroll", update);
  window.addEventListener("scroll", update);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, () => inset);
}
