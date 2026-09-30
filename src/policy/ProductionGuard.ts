import type { BrowserContext } from 'playwright';
import type { TestDefinition } from '../shared/test-schema';
import type { TestEnvironment } from '../shared/types';

export class PolicyError extends Error { constructor(message: string) { super(message); this.name = 'PolicyError'; } }

/** Network restrictions apply to every environment, including local sessions. */
export class ProductionGuard {
  private readonly timestamps: number[] = [];
  private readonly blockedPaths: RegExp[];

  constructor(readonly environment: TestEnvironment) {
    this.blockedPaths = (environment.policy?.blockedPathPatterns || []).map(pattern => new RegExp(pattern, 'i'));
    const base = new URL(environment.baseURL);
    if (!['http:', 'https:'].includes(base.protocol)) throw new PolicyError('Environment base URL must use HTTP or HTTPS');
    this.checkURL(base.href);
  }

  validate(test: TestDefinition): void {
    const { production, policy } = this.environment;
    if (production) {
      if (!policy?.enabled) throw new PolicyError('Production is disabled in server configuration');
      if (!test.productionAllowed) throw new PolicyError('Test must explicitly opt in to production');
      if (test.safetyLevel === 'destructive') throw new PolicyError('Destructive production tests are blocked');
      if (policy.requireTestAccount && (!policy.testAccount || test.testAccount !== policy.testAccount)) throw new PolicyError('Production requires the configured dedicated test account');
    }
    for (const step of test.steps) {
      if (production && policy?.blockedActions.includes(step.action)) throw new PolicyError(`Action ${step.action} is blocked in production`);
      if (step.action === 'goto' || step.action === 'newPage' && step.path) this.checkURL(new URL(step.path!, this.environment.baseURL).href);
    }
  }

  checkURL(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new PolicyError('Invalid target URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new PolicyError(`Protocol ${url.protocol} is not allowed`);
    if (url.username || url.password) throw new PolicyError('Credentials in URLs are not allowed');
    // Exact hostname matching avoids suffix tricks such as trusted.example.evil.test.
    if (!this.environment.allowedDomains.some(domain => domain.toLowerCase() === url.hostname.toLowerCase())) throw new PolicyError(`Domain ${url.hostname} is outside the environment allowlist`);
    if (this.environment.production) {
      let pathname = url.pathname;
      for (let i = 0; i < 3; i++) { try { const decoded = decodeURIComponent(pathname); if (decoded === pathname) break; pathname = decoded; } catch { throw new PolicyError('Invalid encoded request path'); } }
      if (this.blockedPaths.some(pattern => pattern.test(pathname))) throw new PolicyError('Request path is blocked by production policy');
    }
    return url;
  }

  checkRequest(url: string, method: string): void {
    this.checkURL(url);
    if (!this.environment.production) return;
    const policy = this.environment.policy;
    if (!policy?.enabled) throw new PolicyError('Production is disabled in server configuration');
    if (policy.blockedMethods.some(blocked => blocked.toUpperCase() === method.toUpperCase())) throw new PolicyError(`HTTP ${method.toUpperCase()} is blocked by production policy`);
    const now = Date.now();
    while (this.timestamps.length && this.timestamps[0]! <= now - 60_000) this.timestamps.shift();
    if (this.timestamps.length >= policy.requestsPerMinute) throw new PolicyError('Production request rate limit exceeded');
    this.timestamps.push(now);
  }

  async install(context: BrowserContext, onViolation: (error: Error) => void = () => {}): Promise<void> {
    // Playwright cannot route requests handled by service workers, so callers must block them.
    await context.route('**/*', async route => {
      try {
        this.checkRequest(route.request().url(), route.request().method());
        // Redirect chains skip browser route callbacks. Inspect without following, fail closed.
        const response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
        try {
          if ([301, 302, 303, 307, 308].includes(response.status())) {
            const location = response.headers()['location'];
            if (location) this.checkURL(new URL(location, route.request().url()).href);
            throw new PolicyError('HTTP redirects are blocked by the V1 network guard; configure a direct destination URL');
          }
          await route.fulfill({ response });
        } finally { await response.dispose(); }
      } catch (error) {
        if (error instanceof PolicyError) onViolation(error);
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', ws => {
      try { this.checkRequest(ws.url(), 'GET'); ws.connectToServer(); }
      catch (error) { onViolation(error instanceof Error ? error : new Error('WebSocket blocked')); ws.close({ code: 1008, reason: 'Environment policy' }); }
    });
  }
}
