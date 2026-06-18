import type {
  BrowserFrameMeta,
  BrowserInput,
  ClientMessage,
  ServerMessage,
} from "@clawdot/protocol";

/**
 * Client half of the remote browser. The daemon runs a real headless Chromium
 * tab (one per session) and streams it as JPEG frames; this drives it.
 *
 * Sessions are organized into persistent **views**, one per stable key (a
 * terminal session id). A view keeps its tab running on the daemon even while
 * its panel is unmounted — switching terminal sessions backgrounds the view
 * (pauses streaming) rather than closing it, so switching back resumes the same
 * live page instantly. The daemon already supports any number of concurrent
 * tabs; this is what lets each session own one. See apps/cli/src/browser.ts.
 */

export interface PreviewFrame {
  /** base64 JPEG. */
  data: string;
  meta: BrowserFrameMeta;
}

/** What was last opened in a view (drives the address bar / port box). */
export interface ViewState {
  open: boolean;
  url: string;
  target: { port?: number; url?: string } | null;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** A mounted panel observing a view. */
export interface ViewSubscriber {
  onFrame(frame: PreviewFrame): void;
  onState(state: ViewState): void;
}

/** Persistent handle for one preview slot; survives panel unmounts. */
export interface PreviewView {
  state(): ViewState;
  /** Open (or replace) the tab. */
  open(opts: {
    port?: number;
    url?: string;
    width: number;
    height: number;
    dpr: number;
  }): void;
  navigate(url: string): void;
  /** History back/forward and reload — the browser-chrome buttons. */
  back(): void;
  forward(): void;
  reload(): void;
  input(event: BrowserInput): void;
  resize(width: number, height: number, dpr: number): void;
  /** Evaluate a JS expression in the page; resolves to the (JSON) result. */
  eval(expression: string): Promise<unknown>;
  /** Snapshot the tab's serialized DOM. */
  dom(): Promise<string>;
  /** Close the tab and clear the slot. */
  close(): void;
  /**
   * Attach a panel. Immediately replays the current state and last frame, and
   * resumes streaming while attached. The returned function detaches and
   * (when the last subscriber leaves) pauses streaming without closing the tab.
   */
  subscribe(sub: ViewSubscriber): () => void;
}

export interface BrowserClient {
  handleServerMessage(msg: ServerMessage): void;
  /** The persistent view for a key (created on first use). */
  view(key: string): PreviewView;
  /** Close any views whose key isn't in `keep` (e.g. a removed session). */
  retainViews(keep: Set<string>): void;
  /** The daemon connection dropped — every tab is gone; mark views closed. */
  connectionLost(): void;
  dispose(): void;
}

interface ViewImpl extends PreviewView {
  _sessionId: string | null;
  _state: ViewState;
  _lastFrame: PreviewFrame | null;
  _subs: Set<ViewSubscriber>;
  _pending: Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >;
}

export function createBrowserClient(
  post: (msg: ClientMessage) => void,
): BrowserClient {
  const views = new Map<string, ViewImpl>();
  const bySession = new Map<string, ViewImpl>();

  const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const makeView = (): ViewImpl => {
    const notifyState = () => {
      for (const sub of view._subs) sub.onState(view._state);
    };

    const detach = (sessionId: string | null) => {
      if (sessionId) {
        bySession.delete(sessionId);
        view._pending.forEach((p) => p.reject(new Error("browser tab closed")));
        view._pending.clear();
      }
    };

    const request = (send: (requestId: string) => void) => {
      if (!view._sessionId) return Promise.reject(new Error("no open tab"));
      const requestId = newId();
      return new Promise<unknown>((resolve, reject) => {
        view._pending.set(requestId, { resolve, reject });
        send(requestId);
      });
    };

    const view: ViewImpl = {
      _sessionId: null,
      _state: {
        open: false,
        url: "",
        target: null,
        error: null,
        canGoBack: false,
        canGoForward: false,
      },
      _lastFrame: null,
      _subs: new Set(),
      _pending: new Map(),

      state: () => view._state,

      open(opts) {
        // Replace any existing tab for this slot.
        if (view._sessionId) {
          post({ type: "browser.close", sessionId: view._sessionId });
          detach(view._sessionId);
        }
        const sessionId = newId();
        view._sessionId = sessionId;
        bySession.set(sessionId, view);
        view._lastFrame = null;
        view._state = {
          open: true,
          url: opts.url ?? "",
          target:
            opts.url !== undefined ? { url: opts.url } : { port: opts.port },
          error: null,
          canGoBack: false,
          canGoForward: false,
        };
        post({
          type: "browser.open",
          sessionId,
          ...(opts.url !== undefined ? { url: opts.url } : {}),
          ...(opts.port !== undefined ? { port: opts.port } : {}),
          width: opts.width,
          height: opts.height,
          dpr: opts.dpr,
        });
        notifyState();
      },

      navigate(url) {
        if (view._sessionId)
          post({ type: "browser.navigate", sessionId: view._sessionId, url });
      },

      back() {
        if (view._sessionId)
          post({ type: "browser.action", sessionId: view._sessionId, action: "back" });
      },

      forward() {
        if (view._sessionId)
          post({ type: "browser.action", sessionId: view._sessionId, action: "forward" });
      },

      reload() {
        if (view._sessionId)
          post({ type: "browser.action", sessionId: view._sessionId, action: "reload" });
      },

      input(event) {
        if (view._sessionId)
          post({ type: "browser.input", sessionId: view._sessionId, event });
      },

      resize(width, height, dpr) {
        if (view._sessionId)
          post({
            type: "browser.resize",
            sessionId: view._sessionId,
            width,
            height,
            dpr,
          });
      },

      eval: (expression) =>
        request((requestId) =>
          post({
            type: "browser.eval",
            sessionId: view._sessionId!,
            requestId,
            expression,
          }),
        ),

      dom: () =>
        request((requestId) =>
          post({ type: "browser.dom", sessionId: view._sessionId!, requestId }),
        ).then((html) => html as string),

      close() {
        if (view._sessionId) {
          post({ type: "browser.close", sessionId: view._sessionId });
          detach(view._sessionId);
        }
        view._sessionId = null;
        view._lastFrame = null;
        view._state = {
          open: false,
          url: "",
          target: null,
          error: null,
          canGoBack: false,
          canGoForward: false,
        };
        notifyState();
      },

      subscribe(sub) {
        const wasEmpty = view._subs.size === 0;
        view._subs.add(sub);
        // Replay current state + last frame so the panel repaints immediately.
        sub.onState(view._state);
        if (view._lastFrame) sub.onFrame(view._lastFrame);
        // First viewer back → resume the daemon's stream.
        if (wasEmpty && view._sessionId)
          post({ type: "browser.setActive", sessionId: view._sessionId, active: true });
        return () => {
          view._subs.delete(sub);
          if (view._subs.size === 0 && view._sessionId)
            post({
              type: "browser.setActive",
              sessionId: view._sessionId,
              active: false,
            });
        };
      },
    };
    return view;
  };

  return {
    handleServerMessage(msg) {
      switch (msg.type) {
        case "browser.opened": {
          const view = bySession.get(msg.sessionId);
          if (!view) break;
          view._state = {
            ...view._state,
            open: true,
            url: msg.url,
            error: null,
            canGoBack: false,
            canGoForward: false,
          };
          for (const sub of view._subs) sub.onState(view._state);
          break;
        }
        case "browser.frame": {
          const view = bySession.get(msg.sessionId);
          if (!view) break;
          const frame: PreviewFrame = { data: msg.data, meta: msg.meta };
          view._lastFrame = frame;
          for (const sub of view._subs) sub.onFrame(frame);
          break;
        }
        case "browser.navigated": {
          const view = bySession.get(msg.sessionId);
          if (!view) break;
          view._state = {
            ...view._state,
            url: msg.url,
            canGoBack: msg.canGoBack,
            canGoForward: msg.canGoForward,
          };
          for (const sub of view._subs) sub.onState(view._state);
          break;
        }
        case "browser.eval.result": {
          const entry = bySession.get(msg.sessionId)?._pending.get(msg.requestId);
          bySession.get(msg.sessionId)?._pending.delete(msg.requestId);
          if (!entry) break;
          if (msg.ok) entry.resolve(msg.value ? JSON.parse(msg.value) : null);
          else entry.reject(new Error(msg.error ?? "evaluation failed"));
          break;
        }
        case "browser.dom": {
          const entry = bySession.get(msg.sessionId)?._pending.get(msg.requestId);
          bySession.get(msg.sessionId)?._pending.delete(msg.requestId);
          entry?.resolve(msg.html);
          break;
        }
        case "browser.closed": {
          const view = bySession.get(msg.sessionId);
          if (!view) break;
          bySession.delete(msg.sessionId);
          view._sessionId = null;
          view._lastFrame = null;
          view._pending.forEach((p) =>
            p.reject(new Error(msg.message ?? "browser tab closed")),
          );
          view._pending.clear();
          view._state = { ...view._state, open: false, error: msg.message ?? null };
          for (const sub of view._subs) sub.onState(view._state);
          break;
        }
      }
    },

    view(key) {
      let view = views.get(key);
      if (!view) {
        view = makeView();
        views.set(key, view);
      }
      return view;
    },

    retainViews(keep) {
      for (const [key, view] of views) {
        if (keep.has(key)) continue;
        view.close();
        views.delete(key);
      }
    },

    connectionLost() {
      for (const view of views.values()) {
        if (view._sessionId) bySession.delete(view._sessionId);
        view._sessionId = null;
        view._lastFrame = null;
        view._pending.forEach((p) =>
          p.reject(new Error("connection to daemon lost")),
        );
        view._pending.clear();
        view._state = {
          ...view._state,
          open: false,
          error: "connection to daemon lost",
        };
        for (const sub of view._subs) sub.onState(view._state);
      }
    },

    dispose() {
      views.clear();
      bySession.clear();
    },
  };
}
