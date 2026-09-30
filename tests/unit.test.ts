import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import type { BrowserContext, Route } from 'playwright';
import { TestDefinitionSchema, TargetSchema } from '../src/shared/test-schema';
import { ProductionGuard } from '../src/policy/ProductionGuard';
import { Scheduler } from '../src/scheduler/Scheduler';
import { EventBus } from '../src/realtime/EventBus';
import { createRedactor, redactStructured, redactTraceZip } from '../src/runner/redact';
import type { TestEnvironment, RunResult } from '../src/shared/types';
import type { TestRunner } from '../src/runner/TestRunner';

const local: TestEnvironment = { name: 'local', baseURL: 'http://localhost:3210', production: false, allowedDomains: ['localhost'] };
const production: TestEnvironment = { name: 'production', baseURL: 'https://app.example.com', production: true, allowedDomains: ['app.example.com'], policy: { enabled: true, requireTestAccount: true, testAccount: 'test@example.com', maxConcurrency: 1, blockedActions: ['type'], blockedPathPatterns: ['/payments?'], blockedMethods: ['DELETE','POST'], requestsPerMinute: 2 } };
const definition = (id = 'smoke', environment = 'local') => TestDefinitionSchema.parse({ id, environment, steps: [{ action: 'goto', path: '/' }] });

test('IR rejects arbitrary code, unknown keys, invalid coordinates and invalid actions', () => {
  const valid = definition();
  assert.equal(valid.productionAllowed, false);
  assert.throws(() => TestDefinitionSchema.parse({ ...valid, script: 'process.exit()' }));
  assert.throws(() => TestDefinitionSchema.parse({ ...valid, steps: [{ action: 'evaluate', code: 'alert(1)' }] }));
  assert.throws(() => TargetSchema.parse({ strategy: 'coordinates', x: -1, y: 20 }));
  assert.throws(() => TargetSchema.parse({ strategy: 'coordinates', x: Infinity, y: 20 }));
  assert.throws(() => TestDefinitionSchema.parse({ ...valid, steps: [] }));
});

test('domain policy is exact and blocks file/data/javascript protocols in every environment', () => {
  const guard = new ProductionGuard(local);
  assert.doesNotThrow(() => guard.checkRequest('http://localhost:3210/debug', 'GET'));
  for (const url of ['https://localhost.evil.test/', 'file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)', 'http://user:password@localhost/']) assert.throws(() => guard.checkURL(url));
  assert.throws(() => guard.validate(TestDefinitionSchema.parse({ ...definition(), steps: [{ action: 'goto', path: '//evil.example/' }] })));
});

test('production requires deployment enablement, test opt-in and matching dedicated account', () => {
  const guard = new ProductionGuard(production);
  const approved = { ...definition('prod','production'), productionAllowed: true, testAccount: 'test@example.com' };
  assert.throws(() => guard.validate(definition('prod','production')), /opt in/);
  assert.throws(() => guard.validate({ ...approved, testAccount: 'other@example.com' }), /account/);
  assert.throws(() => guard.validate({ ...approved, safetyLevel: 'destructive' }), /Destructive/);
  assert.throws(() => new ProductionGuard({ ...production, policy: { ...production.policy!, enabled: false } }).validate(approved), /disabled/);
  assert.doesNotThrow(() => guard.validate(approved));
  assert.throws(() => guard.validate({ ...approved, steps: [{ action: 'type', value: 'hello' }] }), /blocked/);
});

test('production blocks encoded paths and methods; enforces a shared guard request budget', () => {
  const guard = new ProductionGuard(production);
  assert.throws(() => guard.checkRequest('https://app.example.com/%70ayments/checkout', 'GET'), /path/);
  assert.throws(() => guard.checkRequest('https://app.example.com/orders', 'delete'), /DELETE/);
  guard.checkRequest('https://app.example.com/', 'GET');
  guard.checkRequest('https://app.example.com/', 'GET');
  assert.throws(() => guard.checkRequest('https://app.example.com/', 'GET'), /rate limit/);
});

test('logs redact literal, JSON-escaped, URL-encoded and bearer secrets', () => {
  const redact = createRedactor(['secret text', 'multi\nline']);
  assert.equal(redact('secret text secret%20text multi\\nline Bearer abc123'), '[REDACTED] [REDACTED] [REDACTED] Bearer [REDACTED]');
  assert.equal(redact('https://example.com/?token=abcdef&item=2'), 'https://example.com/?token=[REDACTED]&item=2');
});

test('network guard blocks redirect responses without following their Location', async () => {
  const guard = new ProductionGuard(local);
  let routeHandler!: (route: Route) => Promise<void>;
  await guard.install({ route: async (_pattern: unknown, handler: typeof routeHandler) => { routeHandler = handler; }, routeWebSocket: async () => {} } as unknown as BrowserContext);
  let fetches = 0, aborted = false, disposed = false, fulfilled = false;
  await routeHandler({
    request: () => ({ url: () => 'http://localhost:3210/redirect', method: () => 'GET' }),
    fetch: async (options: { maxRedirects: number }) => { fetches++; assert.equal(options.maxRedirects, 0); return { status: () => 302, headers: () => ({ location: 'https://evil.example/leak' }), dispose: async () => { disposed = true; } }; },
    abort: async () => { aborted = true; }, fulfill: async () => { fulfilled = true; },
  } as unknown as Route);
  assert.equal(fetches, 1); assert.equal(aborted, true); assert.equal(disposed, true); assert.equal(fulfilled, false);
});

test('trace redaction preserves a readable ZIP and JSON when secrets contain quotes/newlines', () => {
  const secret = 'quote"\nand newline', redact = createRedactor([secret]);
  const original = JSON.stringify({ type: 'before', apiName: 'locator.fill', params: { value: secret } }) + '\n';
  const name = Buffer.from('trace.trace'), content = Buffer.from(original), compressed = deflateRawSync(content);
  const localHeader = Buffer.alloc(30), central = Buffer.alloc(46), footer = Buffer.alloc(22);
  localHeader.writeUInt32LE(0x04034b50); localHeader.writeUInt16LE(8, 8); localHeader.writeUInt32LE(compressed.length, 18); localHeader.writeUInt32LE(content.length, 22); localHeader.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(1, 8); footer.writeUInt16LE(1, 10); footer.writeUInt32LE(central.length + name.length, 12); footer.writeUInt32LE(localHeader.length + name.length + compressed.length, 16);
  const zip = redactTraceZip(Buffer.concat([localHeader, name, compressed, central, name, footer]), redact);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(8), 0);
  const start = 30 + zip.readUInt16LE(26), length = zip.readUInt32LE(18);
  assert.deepEqual(JSON.parse(zip.subarray(start, start + length).toString()), { type: 'before', apiName: 'locator.fill', params: { value: '[REDACTED]' } });
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.deepEqual(redactStructured({ message: secret, count: 3 }, redact), { message: '[REDACTED]', count: 3 });
});

test('scheduler runs independent environments concurrently and obeys production cap', async () => {
  const bus = new EventBus(), pending = new Map<string, () => void>(), started: string[] = [];
  const runner: Pick<TestRunner, 'run' | 'environment'> = {
    environment: name => name === 'production' ? production : local,
    async run(value, options) {
      started.push(value.id);
      await new Promise<void>(resolve => pending.set(value.id, resolve));
      return { id: options!.runId!, testId: value.id, name: value.name, environment: value.environment, mode: options!.mode!, status: 'passed', steps: [], artifacts: [] } satisfies RunResult;
    },
  };
  const scheduler = new Scheduler(runner, bus, { concurrency: 2, historyLimit: 2 });
  const first = scheduler.submit(definition('prod-1', 'production'));
  const second = scheduler.submit(definition('prod-2', 'production'));
  const third = scheduler.submit(definition('local-1'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['prod-1', 'local-1']);
  pending.get('local-1')!(); await scheduler.wait(third.id);
  assert.deepEqual(started, ['prod-1', 'local-1']);
  pending.get('prod-1')!(); await scheduler.wait(first.id);
  assert.deepEqual(started, ['prod-1', 'local-1', 'prod-2']);
  pending.get('prod-2')!(); await scheduler.wait(second.id);
  assert.equal(scheduler.list().length, 2);
  await scheduler.close();
  assert.equal(bus.listenerCount, 0);
});

test('queued cancellation never executes the cancelled test', async () => {
  const bus = new EventBus(); let release!: () => void; const started: string[] = [];
  const runner: Pick<TestRunner, 'run' | 'environment'> = {
    environment: () => local,
    async run(value, options) { started.push(value.id); await new Promise<void>(resolve => { release = resolve; }); return { id: options!.runId!, testId: value.id, name: value.name, environment: 'local', mode: 'fast', status: 'passed', steps: [], artifacts: [] }; },
  };
  const scheduler = new Scheduler(runner, bus, { concurrency: 1 });
  const first = scheduler.submit(definition('first')), second = scheduler.submit(definition('second'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.cancel(second.id), true);
  assert.equal((await scheduler.wait(second.id)).status, 'cancelled');
  release(); await scheduler.wait(first.id);
  assert.deepEqual(started, ['first']);
  await scheduler.close();
});
