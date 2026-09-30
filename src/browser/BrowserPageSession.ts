import { randomUUID } from 'node:crypto';
import type { ConsoleMessage, Frame, Page, Request, Response } from 'playwright';
import type { EventInput, ExecutionMode, PageInfo, ViewportState } from '../shared/types.js';
import type { EventBus } from '../realtime/EventBus.js';
import type { BrowserMouse } from './input/BrowserMouse.js';
import type { BrowserKeyboard } from './input/BrowserKeyboard.js';
import { PlaywrightMouse } from './input/PlaywrightMouse.js';
import { PlaywrightKeyboard } from './input/PlaywrightKeyboard.js';
import { OperationQueue } from './OperationQueue.js';
import { redactDiagnostics } from './redactDiagnostics.js';

export interface ConsoleEntry { timestamp: number; type: string; text: string }
export interface NetworkEntry { timestamp: number; method: string; url: string; resourceType: string; status?: number; error?: string; durationMs?: number }

export class BrowserPageSession {
  readonly id = `page-${randomUUID()}`;
  readonly mouse: BrowserMouse;
  readonly keyboard: BrowserKeyboard;
  readonly consoleMessages: ConsoleEntry[] = [];
  readonly networkRequests: NetworkEntry[] = [];
  private readonly queue = new OperationQueue();
  private readonly requests = new WeakMap<Request, NetworkEntry>();
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private viewport: ViewportState;

  constructor(
    readonly sessionId: string,
    readonly page: Page,
    private readonly bus: EventBus,
    readonly mode: ExecutionMode,
    readonly runId: string | undefined,
    private readonly onClosed: (page: BrowserPageSession) => void,
    deviceScaleFactor = 1,
    private readonly redactor?: (value: string) => string,
  ) {
    this.viewport = { ...(page.viewportSize() ?? { width: 1280, height: 800 }), deviceScaleFactor, scrollX: 0, scrollY: 0 };
    this.mouse = new PlaywrightMouse(page, this.emit, mode, this.queue);
    this.keyboard = new PlaywrightKeyboard(page, this.emit, this.queue);
    page.on('close', this.handleClose);
    page.on('crash', this.handleCrash);
    page.on('framenavigated', this.handleNavigation);
    page.on('load', this.handleLoad);
    page.on('console', this.handleConsole);
    page.on('pageerror', this.handlePageError);
    page.on('request', this.handleRequest);
    page.on('response', this.handleResponse);
    page.on('requestfinished', this.handleRequestFinished);
    page.on('requestfailed', this.handleRequestFailed);
  }

  /** Called after page:created is published so frames never precede page registration. */
  start(): void { if (this.mode === 'watch') this.scheduleFrame(0); }

  execute<T>(operation: () => Promise<T>): Promise<T> { return this.queue.run(operation); }

  info(): PageInfo {
    const size = this.page.viewportSize();
    return { id: this.id, sessionId: this.sessionId, url: this.redact(this.page.url()), mouse: this.mouse.getState(), viewport: { ...this.viewport, ...size } };
  }

  async refreshViewport(): Promise<void> {
    if (this.disposed || this.page.isClosed()) return;
    try {
      this.viewport = await this.page.evaluate(() => ({
        width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio,
        scrollX: window.scrollX, scrollY: window.scrollY,
      }));
    } catch { /* Navigation can temporarily remove the execution context. */ }
  }

  async captureDiagnostics(): Promise<Record<string, unknown>> {
    await this.refreshViewport();
    let semanticSnapshot = '';
    try { semanticSnapshot = (await this.page.locator('body').ariaSnapshot({ timeout: 2000 })).slice(0, 100_000); }
    catch { /* A closed or crashed page still has useful browser-side diagnostics. */ }
    return {
      url: this.redact(this.page.url()), viewport: this.info().viewport, mouse: this.mouse.getState(),
      console: [...this.consoleMessages], network: this.networkRequests.map(entry => ({ ...entry })), semanticSnapshot: this.redact(semanticSnapshot),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.close();
    clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.page.off('close', this.handleClose);
    this.page.off('crash', this.handleCrash);
    this.page.off('framenavigated', this.handleNavigation);
    this.page.off('load', this.handleLoad);
    this.page.off('console', this.handleConsole);
    this.page.off('pageerror', this.handlePageError);
    this.page.off('request', this.handleRequest);
    this.page.off('response', this.handleResponse);
    this.page.off('requestfinished', this.handleRequestFinished);
    this.page.off('requestfailed', this.handleRequestFailed);
  }

  private readonly emit = (event: EventInput): void => {
    if (!this.disposed) this.bus.publish({ ...event, ...(typeof event.key === 'string' ? { key: this.redact(event.key) } : {}), sessionId: this.sessionId, pageId: this.id, ...(this.runId ? { runId: this.runId } : {}) });
  };
  private readonly handleClose = (): void => {
    this.emit({ type: 'page:closed' });
    this.dispose();
    this.onClosed(this);
  };
  private readonly handleCrash = (): void => { this.emit({ type: 'page:crashed', url: this.redact(this.page.url()) }); };
  private readonly handleNavigation = (frame: Frame): void => {
    if (frame === this.page.mainFrame()) {
      this.emit({ type: 'page:updated', page: this.info(), url: this.redact(this.page.url()) });
      void this.refreshViewport();
    }
  };
  private readonly handleLoad = (): void => {
    void this.refreshViewport().then(() => { this.emit({ type: 'page:updated', page: this.info(), url: this.redact(this.page.url()) }); });
  };
  private readonly handleConsole = (message: ConsoleMessage): void => {
    this.pushConsole({ timestamp: Date.now(), type: message.type(), text: message.text().slice(0, 16_000) });
  };
  private readonly handlePageError = (error: Error): void => {
    this.pushConsole({ timestamp: Date.now(), type: 'pageerror', text: (error.stack ?? error.message).slice(0, 16_000) });
  };
  private pushConsole(entry: ConsoleEntry): void {
    entry.text = this.redact(entry.text);
    this.consoleMessages.push(entry);
    if (this.consoleMessages.length > 500) this.consoleMessages.shift();
    // Live viewers need the severity; console text belongs in redacted diagnostics.
    this.emit({ type: 'page:console', consoleType: entry.type });
  }
  private readonly handleRequest = (request: Request): void => {
    const entry: NetworkEntry = { timestamp: Date.now(), method: request.method(), url: this.redact(request.url()), resourceType: request.resourceType() };
    this.requests.set(request, entry);
    this.networkRequests.push(entry);
    if (this.networkRequests.length > 500) this.networkRequests.shift();
  };
  private readonly handleResponse = (response: Response): void => {
    const entry = this.requests.get(response.request());
    if (entry) entry.status = response.status();
  };
  private readonly handleRequestFinished = (request: Request): void => {
    const entry = this.requests.get(request);
    if (entry) entry.durationMs = Date.now() - entry.timestamp;
  };
  private readonly handleRequestFailed = (request: Request): void => {
    const entry = this.requests.get(request);
    if (entry) { entry.durationMs = Date.now() - entry.timestamp; entry.error = this.redact(request.failure()?.errorText ?? 'Request failed'); }
  };

  private redact(value: string): string { return redactDiagnostics(value, this.redactor); }

  private scheduleFrame(delayMs: number): void {
    if (this.disposed || this.page.isClosed()) return;
    this.frameTimer = setTimeout(() => { void this.captureFrame(); }, delayMs);
    this.frameTimer.unref();
  }
  private async captureFrame(): Promise<void> {
    if (this.disposed || this.page.isClosed()) return;
    try {
      await this.refreshViewport();
      // Playwright's default caret hiding touches input style attributes. Leave the
      // caret intact so even repeated viewer frames do not mutate application DOM.
      const image = await this.page.screenshot({ type: 'jpeg', quality: 65, scale: 'css', caret: 'initial', timeout: 2500 });
      this.emit({ type: 'browser:frame', data: image.toString('base64'), mimeType: 'image/jpeg', viewport: this.info().viewport });
    } catch { /* Navigation and page shutdown may interrupt a frame. The next scheduled frame retries. */ }
    finally {
      // At most five frames/second, with no overlap or accumulating screenshot work.
      this.scheduleFrame(200);
    }
  }
}
