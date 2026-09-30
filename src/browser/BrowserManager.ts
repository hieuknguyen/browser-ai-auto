import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import type { EventBus } from '../realtime/EventBus.js';
import type { ExecutionMode, SessionInfo } from '../shared/types.js';
import { BrowserPageSession } from './BrowserPageSession.js';

export { BrowserPageSession } from './BrowserPageSession.js';
export interface SessionOptions {
  environment: string;
  mode: ExecutionMode;
  runId?: string;
  viewport?: { width: number; height: number };
  contextOptions?: BrowserContextOptions;
  configureContext?: (context: BrowserContext) => Promise<void>;
  redact?: (value: string) => string;
}

export class BrowserSession {
  readonly id = `session-${randomUUID()}`;
  readonly pages = new Map<string, BrowserPageSession>();
  constructor(readonly context: BrowserContext, readonly options: SessionOptions) {}
  info(): SessionInfo {
    return { id: this.id, environment: this.options.environment, mode: this.options.mode,
      ...(this.options.runId ? { runId: this.options.runId } : {}), pages: [...this.pages.values()].map(page => page.info()) };
  }
}

export class BrowserManager {
  private browser: Browser | undefined;
  private launching: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pages = new Map<string, BrowserPageSession>();
  private readonly pageLookup = new WeakMap<Page, BrowserPageSession>();

  constructor(private readonly bus: EventBus, private readonly options: { headless?: boolean; executablePath?: string } = {}) {}

  async launch(): Promise<void> {
    if (this.closing) throw new Error('Browser manager is closing');
    if (this.browser?.isConnected()) return;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const executablePath = this.options.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      const browser = await chromium.launch({ headless: this.options.headless ?? true, ...(executablePath ? { executablePath } : {}) });
      this.browser = browser;
      browser.once('disconnected', () => {
        if (this.browser === browser) this.browser = undefined;
        this.bus.publish({ type: 'browser:disconnected' });
      });
      this.bus.publish({ type: 'browser:launched', version: browser.version() });
    })();
    try { await this.launching; } finally { this.launching = undefined; }
  }

  /** Creates an empty isolated context. Install guards before calling createPage. */
  async createSession(options: SessionOptions): Promise<BrowserSession> {
    if (!['fast', 'watch'].includes(options.mode)) throw new Error('Unsupported execution mode');
    await this.launch();
    const browser = this.browser;
    if (this.closing || !browser?.isConnected()) throw new Error('Browser manager is closing');
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      ...options.contextOptions,
      serviceWorkers: 'block',
    });
    try {
      await options.configureContext?.(context);
      if (this.closing || !browser.isConnected() || this.browser !== browser) throw new Error('Browser manager closed while creating the session');
    }
    catch (error) { await context.close(); throw error; }
    const session = new BrowserSession(context, options);
    this.sessions.set(session.id, session);
    context.on('page', page => { this.registerPage(session, page); });
    context.once('close', () => {
      for (const page of session.pages.values()) { page.dispose(); this.pages.delete(page.id); }
      session.pages.clear();
      this.sessions.delete(session.id);
      this.bus.publish({ type: 'session:closed', sessionId: session.id, runId: options.runId });
    });
    this.bus.publish({ type: 'session:created', sessionId: session.id, runId: options.runId, session: session.info() });
    for (const page of context.pages()) this.registerPage(session, page);
    return session;
  }

  getSession(id: string): BrowserSession | undefined { return this.sessions.get(id); }
  getPage(pageId: string): BrowserPageSession | undefined { return this.pages.get(pageId); }
  listSessions(): SessionInfo[] { return [...this.sessions.values()].map(session => session.info()); }

  async createPage(sessionId: string): Promise<BrowserPageSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Browser session not found: ${sessionId}`);
    const page = await session.context.newPage();
    return this.pageLookup.get(page) ?? this.registerPage(session, page);
  }

  async closeSession(sessionId: string): Promise<void> { await this.sessions.get(sessionId)?.context.close(); }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.launching?.catch(() => undefined);
      await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id)));
      const browser = this.browser;
      this.browser = undefined;
      await browser?.close();
    })();
    try { await this.closing; } finally { this.closing = undefined; }
  }

  private registerPage(session: BrowserSession, page: Page): BrowserPageSession {
    const existing = this.pageLookup.get(page);
    if (existing) return existing;
    const entry = new BrowserPageSession(session.id, page, this.bus, session.options.mode, session.options.runId, closedPage => {
      session.pages.delete(closedPage.id);
      this.pages.delete(closedPage.id);
    }, session.options.contextOptions?.deviceScaleFactor ?? 1, session.options.redact);
    this.pageLookup.set(page, entry);
    session.pages.set(entry.id, entry);
    this.pages.set(entry.id, entry);
    this.bus.publish({ type: 'page:created', sessionId: session.id, pageId: entry.id, runId: session.options.runId, page: entry.info() });
    entry.start();
    return entry;
  }
}
