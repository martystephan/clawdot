import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Browser as BrowserName,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
  type Protocol,
} from "puppeteer-core";
import type {
  BrowserFrameMeta,
  BrowserInput,
  ServerMessage,
} from "@clawdot/protocol";

/**
 * The remote browser: a single real headless Chromium on the daemon's machine,
 * one tab per session, streamed to the app as JPEG frames over CDP. The page
 * runs server-side — its requests carry the daemon host's IP/DNS/cookies, so
 * a previewed dev server (or any site) can't tell it's being viewed remotely.
 * Replaces the old service-worker HTTP/WS proxy.
 */

/**
 * Coalesce screencast output to the newest frame and emit at most this often.
 * CDP frames are acked immediately (so Chrome keeps painting) but only the
 * latest is forwarded — over a phone link, dropping stale frames beats
 * buffering a backlog the user will never see.
 */
const FRAME_INTERVAL_MS = 60;

/** Launches/locates Chromium and hands out tabs. One per daemon. */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly cacheDir: string;

  constructor(dataDir: string) {
    // Downloaded Chromium (if we have to fetch one) lives in the data dir, so
    // it's isolated per daemon and cleaned up with it.
    this.cacheDir = join(dataDir, "browser");
  }

  /** The shared browser, launched (and Chromium located/downloaded) on demand. */
  async get(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const executablePath = await this.resolveExecutable();
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // Let the daemon own process signals — puppeteer's default handlers close
      // Chrome but suppress the process exit, which would hang a `serve` that's
      // being stopped/restarted. The daemon disposes the browser itself (below).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // --no-sandbox: daemons commonly run as a service / in containers where
      // the sandbox can't initialize; the daemon already trusts what it runs.
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
      ],
    });
    browser.on("disconnected", () => {
      if (this.browser === browser) this.browser = null;
    });
    this.browser = browser;
    return browser;
  }

  /**
   * Find a Chromium to drive, preferring zero-cost options: an explicit
   * override, then a system Chrome, then a previously downloaded one, and only
   * as a last resort downloading one into the data dir (~150 MB, once).
   */
  private async resolveExecutable(): Promise<string> {
    const override =
      process.env.CLAWDOT_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (override && existsSync(override)) return override;

    const platform = detectBrowserPlatform();
    if (!platform) throw new Error("no supported headless-browser platform");

    try {
      const sys = computeSystemExecutablePath({
        browser: BrowserName.CHROME,
        channel: ChromeReleaseChannel.STABLE,
      });
      if (sys && existsSync(sys)) return sys;
    } catch {
      // No system Chrome — fall through to a managed install.
    }

    const installed = await getInstalledBrowsers({ cacheDir: this.cacheDir });
    const cached = installed.find(
      (b) => b.browser === BrowserName.CHROME && existsSync(b.executablePath),
    );
    if (cached) return cached.executablePath;

    // Opt out of the one-time download (CI / tests that just want to verify
    // the path exists when a browser is present).
    if (process.env.CLAWDOT_BROWSER_NO_DOWNLOAD) {
      throw new Error("no Chrome found and downloads are disabled");
    }

    const buildId = await resolveBuildId(
      BrowserName.CHROME,
      platform,
      "stable",
    );
    console.log(
      `clawdot: no Chrome found — downloading headless Chromium ${buildId} to ${this.cacheDir} (one-time, ~150 MB)…`,
    );
    const result = await install({
      browser: BrowserName.CHROME,
      buildId,
      cacheDir: this.cacheDir,
    });
    return result.executablePath;
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}

/** One streamed tab, owned by the connection that opened it. */
export class BrowserSession {
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private closed = false;
  // The most recent captured frame, kept so a resume can repaint instantly;
  // `dirty` gates the flush so unchanged frames aren't resent.
  private lastFrame: { data: string; meta: BrowserFrameMeta } | null = null;
  private dirty = false;
  // Backgrounded views (another session is showing) pause frame delivery; the
  // tab keeps running so switching back resumes without a reload.
  private paused = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly manager: BrowserManager,
    private readonly sessionId: string,
    private readonly send: (msg: ServerMessage) => void,
  ) {}

  async open(opts: {
    port?: number;
    url?: string;
    width: number;
    height: number;
    dpr: number;
  }): Promise<void> {
    const target =
      opts.url ?? `http://localhost:${opts.port ?? 80}/`;
    try {
      const browser = await this.manager.get();
      if (this.closed) return;
      const page = await browser.newPage();
      this.page = page;
      await page.setViewport({
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: opts.dpr,
      });
      const cdp = await page.createCDPSession();
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (e) => this.onFrame(cdp, e));
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) void this.emitNavigated();
      });
      // Tab crashed or was closed out from under us.
      page.once("close", () => this.fail());

      // Stream even if the load hangs — a dev server mid-restart shouldn't
      // block the view, and navigation events keep the address current.
      void page
        .goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});
      await this.startScreencast(opts.width, opts.height, opts.dpr);
      if (this.closed) return;
      this.flushTimer = setInterval(() => this.flush(), FRAME_INTERVAL_MS);
      this.send({
        type: "browser.opened",
        sessionId: this.sessionId,
        url: target,
        title: "",
      });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async startScreencast(
    width: number,
    height: number,
    dpr: number,
  ): Promise<void> {
    await this.cdp?.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: Math.round(width * dpr),
      maxHeight: Math.round(height * dpr),
      everyNthFrame: 1,
    });
  }

  private onFrame(
    cdp: CDPSession,
    e: Protocol.Page.ScreencastFrameEvent,
  ): void {
    // Ack right away so Chrome keeps painting; we throttle our own output.
    cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
    if (this.closed) return;
    const m = e.metadata;
    this.lastFrame = {
      data: e.data,
      meta: {
        deviceWidth: m.deviceWidth ?? 0,
        deviceHeight: m.deviceHeight ?? 0,
        pageScaleFactor: m.pageScaleFactor ?? 1,
        offsetTop: m.offsetTop ?? 0,
        scrollOffsetX: m.scrollOffsetX ?? 0,
        scrollOffsetY: m.scrollOffsetY ?? 0,
      },
    };
    this.dirty = true;
  }

  private flush(): void {
    if (this.closed || this.paused || !this.dirty || !this.lastFrame) return;
    this.dirty = false;
    this.send({
      type: "browser.frame",
      sessionId: this.sessionId,
      data: this.lastFrame.data,
      meta: this.lastFrame.meta,
    });
  }

  /** Pause/resume streaming. Resuming repaints from the last frame at once. */
  setActive(active: boolean): void {
    if (this.closed) return;
    this.paused = !active;
    if (active && this.lastFrame) {
      this.send({
        type: "browser.frame",
        sessionId: this.sessionId,
        data: this.lastFrame.data,
        meta: this.lastFrame.meta,
      });
      this.dirty = false;
    }
  }

  private async emitNavigated(): Promise<void> {
    if (this.closed || !this.page) return;
    const url = this.page.url();
    const title = await this.page.title().catch(() => "");
    if (this.closed) return;
    const { canGoBack, canGoForward } = await this.history();
    if (this.closed) return;
    this.send({
      type: "browser.navigated",
      sessionId: this.sessionId,
      url,
      title,
      canGoBack,
      canGoForward,
    });
  }

  /** Whether the tab's session history can move back/forward (for the chrome). */
  private async history(): Promise<{
    canGoBack: boolean;
    canGoForward: boolean;
  }> {
    try {
      const h = await this.cdp?.send("Page.getNavigationHistory");
      if (!h) return { canGoBack: false, canGoForward: false };
      return {
        canGoBack: h.currentIndex > 0,
        canGoForward: h.currentIndex < h.entries.length - 1,
      };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  navigate(url: string): void {
    void this.page?.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }

  /** Browser-chrome navigation buttons: back, forward, reload. */
  action(action: "back" | "forward" | "reload"): void {
    const page = this.page;
    if (!page || this.closed) return;
    const opts = { waitUntil: "domcontentloaded" as const, timeout: 30_000 };
    if (action === "back") void page.goBack(opts).catch(() => {});
    else if (action === "forward") void page.goForward(opts).catch(() => {});
    else void page.reload(opts).catch(() => {});
  }

  input(event: BrowserInput): void {
    const cdp = this.cdp;
    if (!cdp || this.closed) return;
    if (event.kind === "mouse") {
      void cdp
        .send("Input.dispatchMouseEvent", {
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button,
          buttons: event.buttons,
          clickCount: event.clickCount,
          modifiers: event.modifiers,
        })
        .catch(() => {});
    } else if (event.kind === "wheel") {
      void cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: event.modifiers,
        })
        .catch(() => {});
    } else if (event.kind === "text") {
      // Paste: insert the whole string into the focused element at once.
      void cdp.send("Input.insertText", { text: event.text }).catch(() => {});
    } else {
      void cdp
        .send("Input.dispatchKeyEvent", {
          type: event.type,
          text: event.text,
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.windowsVirtualKeyCode,
          modifiers: event.modifiers,
        })
        .catch(() => {});
    }
  }

  async resize(width: number, height: number, dpr: number): Promise<void> {
    if (!this.page || this.closed) return;
    try {
      await this.page.setViewport({
        width,
        height,
        deviceScaleFactor: dpr,
      });
      await this.cdp?.send("Page.stopScreencast").catch(() => {});
      await this.startScreencast(width, height, dpr);
    } catch {
      // Page may have gone away mid-resize — the close handler covers it.
    }
  }

  async evaluate(requestId: string, expression: string): Promise<void> {
    if (!this.cdp || this.closed) return;
    try {
      // CDP Runtime.evaluate, not in-page eval(): the debugger context isn't
      // subject to the page's CSP, so DOM access works even on strict sites.
      const res = await this.cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (this.closed) return;
      if (res.exceptionDetails) {
        this.send({
          type: "browser.eval.result",
          sessionId: this.sessionId,
          requestId,
          ok: false,
          error:
            res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text,
        });
        return;
      }
      this.send({
        type: "browser.eval.result",
        sessionId: this.sessionId,
        requestId,
        ok: true,
        value: JSON.stringify(res.result.value ?? null),
      });
    } catch (err) {
      if (this.closed) return;
      this.send({
        type: "browser.eval.result",
        sessionId: this.sessionId,
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async dom(requestId: string): Promise<void> {
    if (!this.page || this.closed) return;
    const html = await this.page.content().catch(() => "");
    if (this.closed) return;
    this.send({
      type: "browser.dom",
      sessionId: this.sessionId,
      requestId,
      html,
    });
  }

  /** Tear down silently (client closed it, or the connection dropped). */
  close(): void {
    this.teardown();
  }

  /** Tear down and tell the client the tab is gone (crash / open failure). */
  private fail(message?: string): void {
    if (this.closed) return;
    const id = this.sessionId;
    this.teardown();
    this.send({ type: "browser.closed", sessionId: id, message });
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.lastFrame = null;
    this.dirty = false;
    const page = this.page;
    this.page = null;
    this.cdp = null;
    void page?.close().catch(() => {});
  }
}
