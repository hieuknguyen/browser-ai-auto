import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '@playwright/test';
import type { BrowserManager, BrowserPageSession, BrowserSession } from '../browser/BrowserManager';
import type { EventBus } from '../realtime/EventBus';
import { TestDefinitionSchema, type TestDefinition, type TestStep } from '../shared/test-schema';
import type { ExecutionMode, RunResult, TestEnvironment } from '../shared/types';
import { ProductionGuard } from '../policy/ProductionGuard';
import { resolveLocator, targetPosition } from './LocatorEngine';
import { createRedactor, redactStructured, redactTraceZip } from './redact';

export interface RunnerOptions { environments: TestEnvironment[]; artifactRoot: string }
export interface RunOptions { mode?: ExecutionMode; runId?: string; signal?: AbortSignal }

export class TestRunner {
  private readonly guards = new Map<string, ProductionGuard>();
  constructor(private readonly manager: BrowserManager, private readonly bus: EventBus, readonly options: RunnerOptions) {
    for (const environment of options.environments) this.guards.set(environment.name, new ProductionGuard(environment));
  }
  environment(name: string): TestEnvironment {
    const environment = this.options.environments.find(item => item.name === name);
    if (!environment) throw new Error(`Unknown environment: ${name}`);
    return environment;
  }

  async run(input: TestDefinition, options: RunOptions = {}): Promise<RunResult> {
    const test = TestDefinitionSchema.parse(input), mode = options.mode || 'fast', id = options.runId || randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid run identifier');
    const result: RunResult = { id, testId: test.id, name: test.name, environment: test.environment, mode, status: 'running', startedAt: Date.now(), steps: [], artifacts: [] };
    const directory = resolve(this.options.artifactRoot, id);
    let session: BrowserSession | undefined, active: BrowserPageSession | undefined, traceStarted = false, policyFailure: Error | undefined;
    const values = new Set<string>();
    const resolveValue = (value: string): string => value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
      if (!name.startsWith('TEST_')) throw new Error('Only TEST_ environment variables may be referenced by test inputs');
      const resolved = process.env[name];
      if (resolved === undefined) throw new Error(`Missing test variable: ${name}`);
      values.add(resolved); return resolved;
    });
    for (const step of test.steps) if (step.action === 'fill' || step.action === 'type') values.add(step.value);
    const redact = (value: string) => createRedactor(values)(value);
    const publish = () => this.bus.publish({ type: 'run:updated', runId: id, run: structuredClone(result) });
    const artifact = (name: string) => result.artifacts.push({ name, url: `/artifacts/${id}/${name}` });
    const saveJSON = async (name: string, value: unknown) => { await writeFile(join(directory, name), JSON.stringify(redactStructured(value, redact), null, 2)); artifact(name); };
    const controller = new AbortController();
    const abort = () => { controller.abort(options.signal?.reason || new Error('Run cancelled')); if (session) void this.manager.closeSession(session.id).catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => { controller.abort(new Error(`Test exceeded its ${test.timeoutMs} ms timeout`)); if (session) void this.manager.closeSession(session.id).catch(() => {}); }, test.timeoutMs);
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason; if (policyFailure) throw policyFailure; };
    publish();
    try {
      await mkdir(directory, { recursive: true });
      check();
      const environment = this.environment(test.environment), guard = this.guards.get(test.environment)!;
      guard.validate(test);
      // Resolve inputs before launching so a missing secret never triggers a partial test.
      const steps = test.steps.map(step => step.action === 'fill' || step.action === 'type' ? { ...step, value: resolveValue(step.value) } : step);
      session = await this.manager.createSession({ environment: test.environment, mode, runId: id, viewport: test.viewport, redact, contextOptions: { baseURL: environment.baseURL, serviceWorkers: 'block', acceptDownloads: false } });
      result.sessionId = session.id;
      await guard.install(session.context, error => { policyFailure ||= error; this.bus.publish({ type: 'policy:blocked', runId: id, sessionId: session!.id, message: redact(error.message) }); });
      check();
      await session.context.tracing.start({ screenshots: false, snapshots: false, sources: false });
      traceStarted = true;
      active = await this.manager.createPage(session.id);
      const aliases = new Map<string, string>([['main', active.id]]);
      publish();
      for (let index = 0; index < steps.length; index++) {
        check();
        const step = steps[index]!, started = Date.now();
        this.bus.publish({ type: 'test:step', runId: id, sessionId: session.id, pageId: active.id, index, action: step.action, status: 'started' });
        try {
          active = await this.perform(step, active, session, aliases, environment.baseURL, directory, artifact);
          check();
          result.steps.push({ index, action: step.action, status: 'passed', durationMs: Date.now() - started });
          this.bus.publish({ type: 'test:step', runId: id, sessionId: session.id, pageId: active.id, index, action: step.action, status: 'passed' });
          publish();
        } catch (error) {
          const message = redact(String((policyFailure || error) instanceof Error ? (policyFailure || error as Error).message : error));
          result.steps.push({ index, action: step.action, status: 'failed', durationMs: Date.now() - started, error: message });
          this.bus.publish({ type: 'test:step', runId: id, sessionId: session.id, pageId: active.id, index, action: step.action, status: 'failed', error: message });
          throw error;
        }
      }
      check();
      result.status = 'passed';
    } catch (error) {
      result.status = options.signal?.aborted ? 'cancelled' : 'failed';
      const failure = policyFailure || (controller.signal.aborted ? controller.signal.reason : error);
      result.error = redact(failure instanceof Error ? failure.message : String(failure));
      for (let index = result.steps.length; index < test.steps.length; index++) result.steps.push({ index, action: test.steps[index]!.action, status: 'skipped', durationMs: 0 });
      if (active && !active.page.isClosed()) {
        const masks = [active.page.locator('input, textarea, [contenteditable="true"], [data-sensitive]'), ...[...values].filter(value => value.length > 2).map(value => active!.page.getByText(value, { exact: false }))];
        await active.page.screenshot({ path: join(directory, 'failure.png'), caret: 'initial', mask: masks, timeout: 5_000 }).then(() => artifact('failure.png')).catch(() => {});
        await active.captureDiagnostics().then(value => saveJSON('diagnostics.json', value)).catch(() => {});
        await active.page.locator('body').ariaSnapshot({ timeout: 3_000 }).then(value => saveJSON('accessibility.json', { snapshot: value })).catch(() => {});
        // DOM is collected as inert diagnostic text; served as an attachment by the API.
        await active.page.content().then(value => saveJSON('dom.json', { html: value })).catch(() => {});
      }
    } finally {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      if (traceStarted && session) {
        if (result.status === 'failed') {
          const privateDirectory = await mkdtemp(join(tmpdir(), 'browser-engine-trace-'));
          try {
            const path = join(privateDirectory, 'trace.zip');
            await session.context.tracing.stop({ path });
            const clean = redactTraceZip(await readFile(path), redact);
            await writeFile(join(directory, 'trace.zip'), clean); artifact('trace.zip');
          } catch { /* Closing/cancelled contexts may not have a trace. */ }
          finally {
            // Only remove the exact temporary directory allocated for this trace.
            if (resolve(privateDirectory).startsWith(resolve(tmpdir()) + '\\') || resolve(privateDirectory).startsWith(resolve(tmpdir()) + '/')) await rm(privateDirectory, { recursive: true, force: true });
          }
        } else await session.context.tracing.stop().catch(() => {});
      }
      if (session) await this.manager.closeSession(session.id).catch(() => {});
      result.finishedAt = Date.now();
      artifact('result.json');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'result.json'), JSON.stringify(redactStructured(result, redact), null, 2));
      publish();
    }
    return result;
  }

  private async perform(step: TestStep, current: BrowserPageSession, session: BrowserSession, aliases: Map<string, string>, baseURL: string, directory: string, artifact: (name: string) => void): Promise<BrowserPageSession> {
    const timeout = step.timeoutMs ?? 10_000;
    if (step.action === 'newPage') {
      if (aliases.has(step.name)) throw new Error(`Page alias already exists: ${step.name}`);
      const created = await this.manager.createPage(session.id); aliases.set(step.name, created.id);
      if (step.path) await created.page.goto(new URL(step.path, baseURL).href, { waitUntil: 'domcontentloaded', timeout });
      return created;
    }
    if (step.action === 'switchPage') {
      const id = step.page === 'latest' ? [...session.pages.keys()].at(-1) : aliases.get(step.page) || step.page;
      const next = id ? session.pages.get(id) : undefined;
      if (!next || next.page.isClosed()) throw new Error(`Page is unavailable: ${step.page}`);
      return next;
    }
    await current.execute(async () => {
      const { page, mouse, keyboard } = current;
      switch (step.action) {
        case 'goto': await page.goto(new URL(step.path, baseURL).href, { waitUntil: 'domcontentloaded', timeout }); break;
        case 'click': case 'doubleClick': case 'rightClick': {
          const popup = step.action === 'click' && step.popup ? page.waitForEvent('popup', { timeout }) : undefined;
          // Attach a rejection handler immediately in case click fails before the popup arrives.
          popup?.catch(() => {});
          const button = step.action === 'rightClick' ? 'right' : step.button || 'left';
          const clickCount = step.action === 'doubleClick' ? 2 : 1;
          if (step.target.strategy === 'coordinates') {
            const point = await targetPosition(page, step.target, timeout);
            await mouse.click(point.x, point.y, { button, clickCount });
          } else {
            const locator = resolveLocator(page, step.target);
            await locator.click({ trial: true, button, timeout });
            const point = await targetPosition(page, step.target, timeout); mouse.syncPosition(point.x, point.y);
            await locator.click({ button, clickCount, timeout });
            this.bus.publish({ type: 'mouse:down', sessionId: session.id, pageId: current.id, runId: session.info().runId, x: point.x, y: point.y, button, clickCount, status: 'pressed' });
            this.bus.publish({ type: 'mouse:up', sessionId: session.id, pageId: current.id, runId: session.info().runId, x: point.x, y: point.y, button: 'none', releasedButton: button, clickCount, status: 'hovering' });
          }
          if (popup && step.action === 'click' && step.popup) {
            const opened = await popup;
            const registered = [...session.pages.values()].find(item => item.page === opened);
            if (!registered) throw new Error('Popup was not registered by the browser manager');
            aliases.set(step.popup, registered.id);
          }
          break;
        }
        case 'move': case 'hover': {
          if (step.action === 'hover' && step.target.strategy !== 'coordinates') {
            const locator = resolveLocator(page, step.target); await locator.hover({ timeout });
            const point = await targetPosition(page, step.target, timeout); mouse.syncPosition(point.x, point.y);
          } else { const point = await targetPosition(page, step.target, timeout); await mouse.move(point.x, point.y); }
          break;
        }
        case 'fill': await resolveLocator(page, step.target).fill(step.value, { timeout }); break;
        case 'press': if (step.target) await resolveLocator(page, step.target).press(step.key, { timeout }); else await keyboard.press(step.key); break;
        case 'type': await keyboard.type(step.value); break;
        case 'down': await mouse.down(step.button); break;
        case 'up': await mouse.up(step.button); break;
        case 'wheel': await mouse.wheel(step.deltaX, step.deltaY); break;
        case 'drag': {
          if (step.from.strategy !== 'coordinates' && step.to.strategy !== 'coordinates') {
            const from = resolveLocator(page, step.from), to = resolveLocator(page, step.to);
            await from.dragTo(to, { timeout });
            const point = await targetPosition(page, step.to, timeout); mouse.syncPosition(point.x, point.y);
          } else {
            const from = await targetPosition(page, step.from, timeout), to = await targetPosition(page, step.to, timeout);
            await mouse.drag(from, to, { steps: step.steps });
          }
          break;
        }
        case 'wait': await resolveLocator(page, step.target).waitFor({ state: step.state, timeout }); break;
        case 'expectVisible': await expect(resolveLocator(page, step.target)).toBeVisible({ timeout }); break;
        case 'expectText': if (step.exact) await expect(resolveLocator(page, step.target)).toHaveText(step.text, { timeout }); else await expect(resolveLocator(page, step.target)).toContainText(step.text, { timeout }); break;
        case 'select': await resolveLocator(page, step.target).selectOption(step.value, { timeout }); break;
        case 'screenshot': { const name = `${step.name}.png`; await page.screenshot({ path: join(directory, name), caret: 'initial', mask: [page.locator('input,textarea,[contenteditable="true"],[data-sensitive]')], timeout }); artifact(name); break; }
      }
    });
    return current;
  }
}
