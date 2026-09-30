import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/api/app.js';
import type { EngineEvent, TestEnvironment, RunResult } from '../src/shared/types.js';
import { TestDefinitionSchema } from '../src/shared/test-schema.js';

test('HTTP control, websocket events, runner, policy and artifacts work together', { timeout: 120_000 }, async t => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'pointer-api-test-'));
  const local: TestEnvironment = { name: 'local', baseURL: 'http://127.0.0.1:3210', production: false, allowedDomains: ['127.0.0.1', 'localhost'] };
  const production: TestEnvironment = { name: 'production', baseURL: local.baseURL, production: true, allowedDomains: ['127.0.0.1'], policy: { enabled: false, requireTestAccount: true, maxConcurrency: 1, blockedActions: [], blockedMethods: ['DELETE','POST','PUT','PATCH'], blockedPathPatterns: ['/payments'], requestsPerMinute: 100 } };
  const { app, manager, scheduler, bus } = await createApp({ ui: false, environments: [local, production], concurrency: 10, artifactRoot });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`; local.baseURL = base; production.baseURL = base;
  t.after(async () => { await app.close(); });
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const events: EngineEvent[] = [];
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/events');
  socket.on('message', message => events.push(JSON.parse(message.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(() => socket.terminate());

  await t.test('rejects cross-site control and invalid input', async () => {
    assert.equal((await call('GET', '/api/health')).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload: {}, headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.example' } })).statusCode, 403);
    assert.equal((await call('POST', '/api/sessions', { environment: 'production' })).statusCode, 403);
    assert.equal((await call('POST', '/api/runs', { test: { id: 'unsafe', environment: 'production', steps: [{ action: 'goto', path: '/' }] } })).statusCode, 403);
    assert.equal((await call('POST', '/api/runs', { test: { id: 'bad', steps: [{ action: 'eval', code: 'bad()' }] } })).statusCode, 400);
  });

  await t.test('manual sessions deliver browser events and enforce navigation allowlist', async () => {
    const response = await call('POST', '/api/sessions', { environment: 'local', mode: 'fast' });
    assert.equal(response.statusCode, 200, response.body);
    const session = response.json(); const pageId = session.pages[0].id;
    assert.equal((await call('POST', `/api/pages/${pageId}/goto`, { url: base + '/debug/mouse' })).statusCode, 200);
    assert.equal((await call('POST', `/api/pages/${pageId}/goto`, { url: 'file:///etc/passwd' })).statusCode, 403);
    assert.equal((await call('POST', `/api/pages/${pageId}/goto`, { url: 'https://example.com' })).statusCode, 403);
    const page = manager.getPage(pageId)!;
    const box = await page.page.getByTestId('click-target').boundingBox(); assert.ok(box);
    assert.equal((await call('POST', `/api/pages/${pageId}/mouse/click`, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).statusCode, 200);
    assert.equal(await page.page.getByTestId('status').innerText(), 'Clicked 1');
    assert.equal((await call('POST', `/api/pages/${pageId}/mouse/move`, { x: -1, y: 10 })).statusCode, 400);
    await page.page.getByLabel('Your name').focus();
    assert.equal((await call('POST', `/api/pages/${pageId}/keyboard`, { action: 'type', text: 'API works' })).statusCode, 200);
    assert.equal(await page.page.getByLabel('Your name').inputValue(), 'API works');
    const final = (await call('GET', `/api/pages/${pageId}/state`)).json(); assert.equal(final.mouse.button, 'none');
    assert.ok(events.some(event => event.type === 'mouse:down' && event.pageId === pageId && event.sessionId === session.id));
    assert.equal((await call('DELETE', `/api/sessions/${session.id}`)).statusCode, 200);
  });

  await t.test('runs 10 tests concurrently with distinct contexts and no frame capture in fast mode', async () => {
    const sessionIds = new Set<string>(); let active = 0, peak = 0, frames = 0;
    const unsubscribe = bus.subscribe(event => {
      if (event.type === 'session:created') { sessionIds.add(event.sessionId!); peak = Math.max(peak, ++active); }
      if (event.type === 'session:closed') active--;
      if (event.type === 'browser:frame') frames++;
    });
    try {
      const queued: RunResult[] = [];
      for (let i = 0; i < 10; i++) queued.push(scheduler.submit(TestDefinitionSchema.parse({ id: `parallel-${i}`, name: `Parallel ${i}`, steps: [
        { action: 'goto', path: '/debug/mouse' }, { action: 'click', target: { strategy: 'role', role: 'button', name: 'Click target', exact: true } },
        { action: 'expectText', target: { strategy: 'testId', testId: 'status' }, text: 'Clicked 1', exact: true },
        { action: 'fill', target: { strategy: 'label', label: 'Your name' }, value: `Worker ${i}` },
      ] }), 'fast'));
      const runs = await Promise.all(queued.map(run => scheduler.wait(run.id)));
      assert.ok(runs.every(run => run.status === 'passed'), JSON.stringify(runs.map(run => run.error)));
      assert.equal(sessionIds.size, 10); assert.equal(peak, 10); assert.equal(frames, 0); assert.equal(manager.listSessions().length, 0);
    } finally { unsubscribe(); }
  });

  await t.test('failure artifacts include diagnostics, screenshot, trace and redact input values', async () => {
    const secret = 'unique-secret-value-8675309';
    const input = TestDefinitionSchema.parse({ id: 'expected-failure', steps: [
      { action: 'goto', path: '/debug/mouse' },
      { action: 'fill', target: { strategy: 'label', label: 'Your name' }, value: secret },
      { action: 'expectText', target: { strategy: 'testId', testId: 'status' }, text: secret, timeoutMs: 100 },
    ] });
    const queued = scheduler.submit(input, 'fast'); const result = await scheduler.wait(queued.id);
    assert.equal(result.status, 'failed'); assert.ok(!result.error?.includes(secret));
    for (const name of ['failure.png', 'diagnostics.json', 'accessibility.json', 'dom.json', 'trace.zip', 'result.json']) assert.ok(result.artifacts.some(artifact => artifact.name === name), `Missing ${name}`);
    const diagnostics = await readFile(join(artifactRoot, result.id, 'diagnostics.json'), 'utf8');
    assert.ok(!diagnostics.includes(secret)); assert.ok(JSON.parse(diagnostics).mouse);
    const artifact = await call('GET', `/artifacts/${result.id}/diagnostics.json`);
    assert.equal(artifact.statusCode, 200); assert.ok(artifact.headers['content-disposition']);
  });
  socket.terminate();
});
