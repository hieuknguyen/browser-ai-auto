import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { BrowserManager } from '../browser/BrowserManager.js';
import { EventBus } from '../realtime/EventBus.js';
import { ProductionGuard, PolicyError } from '../policy/ProductionGuard.js';
import { TestRunner } from '../runner/TestRunner.js';
import { Scheduler } from '../scheduler/Scheduler.js';
import { TestDefinitionSchema } from '../shared/test-schema.js';
import type { TestEnvironment } from '../shared/types.js';
import { loadEnvironments } from '../../config/environments.js';
import { startDemo } from '../demo.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const point = z.object({ x: z.number().finite().min(0).max(100_000), y: z.number().finite().min(0).max(100_000) });
const button = z.enum(['left', 'right', 'middle']).default('left');
const move = point.extend({ steps: z.number().int().min(1).max(120).default(1), durationMs: z.number().int().min(0).max(3000).optional() }).strict();
const click = point.extend({ button, clickCount: z.number().int().min(1).max(3).default(1), delayMs: z.number().min(0).max(1000).default(0) }).strict();
const mode = z.enum(['watch', 'fast']).default('watch');
export interface AppOptions { ui?: boolean; productionUI?: boolean; environments?: TestEnvironment[]; concurrency?: number; artifactRoot?: string }

export async function createApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, forceCloseConnections: true });
  const bus = new EventBus();
  const manager = new BrowserManager(bus, { headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const environments = options.environments ?? loadEnvironments();
  const concurrency = options.concurrency ?? Number(process.env.ENGINE_CONCURRENCY || 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('ENGINE_CONCURRENCY must be an integer from 1 to 32');
  const artifactRoot = options.artifactRoot ?? resolve(root, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const runner = new TestRunner(manager, bus, { environments, artifactRoot });
  const scheduler = new Scheduler(runner, bus, { concurrency });
  const guards = new Map<string, ProductionGuard>();
  const watchedDemoSessions = new Set<string>();
  let pendingManualSessions = 0;
  let demoStarting = false;
  let vite: import('vite').ViteDevServer | undefined;
  const publicEnvironments = () => environments.map(env => ({ ...env, policy: env.policy ? { ...env.policy, testAccount: undefined } : undefined }));
  const status = () => ({ sessions: manager.listSessions(), runs: scheduler.list(), environments: publicEnvironments(), concurrency });
  const findSession = (id: string) => { const session = manager.getSession(id); if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 }); return session; };
  const findPage = (id: string) => { const page = manager.getPage(id); if (!page) throw Object.assign(new Error('Page not found'), { statusCode: 404 }); return page; };
  const manualPage = (id: string) => { const page = findPage(id); if (!guards.has(page.sessionId)) throw new PolicyError('Runner sessions cannot be modified by manual input'); return page; };

  app.addHook('onRequest', async (request, reply) => {
    // Loopback binding plus Host/Origin checks prevent drive-by cross-site control and DNS rebinding.
    const host = request.headers.host || '';
    const hostname = host.replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return reply.code(403).send({ error: 'Local access only' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return reply.code(403).send({ error: 'Cross-origin control is disabled' });
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', details: error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
    const err = error as Error & { statusCode?: number };
    return reply.code(error instanceof PolicyError ? 403 : err.statusCode ?? 400).send({ error: err.message });
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  app.get('/events', { websocket: true }, socket => {
    socket.send(JSON.stringify({ type: 'state', sequence: 0, timestamp: Date.now(), ...status() }));
    const unsubscribe = bus.subscribe(event => {
      if (socket.readyState !== 1) return;
      // Slow observers lose frames, never stall browser input or grow an unbounded queue.
      if (socket.bufferedAmount > 2_000_000 && event.type === 'browser:frame') return;
      if (socket.bufferedAmount > 8_000_000) { socket.close(1013, 'Viewer is too slow; reconnect'); return; }
      socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe); socket.on('error', unsubscribe);
  });
  app.get('/api/health', () => ({ ok: true, version: '1.0.0' }));
  app.get('/api/status', status);
  app.get('/api/examples', async () => {
    const entries = await readdir(resolve(root, 'examples')).catch(() => [] as string[]);
    const tests = await Promise.all(entries.filter(name => name.endsWith('.json')).map(async name => TestDefinitionSchema.parse(JSON.parse(await readFile(resolve(root, 'examples', name), 'utf8')))));
    return { tests };
  });
  app.post('/api/runs', async (request, reply) => {
    const body = z.object({ test: TestDefinitionSchema, mode }).strict().parse(request.body);
    const test = body.test;
    new ProductionGuard(runner.environment(test.environment)).validate(test);
    return reply.code(202).send(scheduler.submit(test, body.mode));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', request => {
    const run = scheduler.get(request.params.id); if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 }); return run;
  });
  app.delete<{ Params: { id: string } }>('/api/runs/:id', async request => { await scheduler.cancel(request.params.id); return { ok: true }; });
  app.post('/api/sessions', async request => {
    const body = z.object({ environment: z.string().default('local'), mode }).strict().parse(request.body ?? {});
    const environment = runner.environment(body.environment);
    if (environment.production) throw new PolicyError('Production requires a validated test run; manual sessions are disabled');
    if (manager.listSessions().length + pendingManualSessions >= 32) throw new PolicyError('Session limit reached; close unused sessions');
    pendingManualSessions++;
    let sessionId: string | undefined;
    try {
      const session = await manager.createSession(body); sessionId = session.id;
      const guard = new ProductionGuard(environment);
      await guard.install(session.context, error => bus.publish({ type: 'policy:blocked', sessionId: session.id, error: error.message }));
      guards.set(session.id, guard);
      await manager.createPage(session.id);
      return session.info();
    } catch (error) { if (sessionId) { guards.delete(sessionId); await manager.closeSession(sessionId); } throw error; }
    finally { pendingManualSessions--; }
  });
  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async request => {
    const session = findSession(request.params.sessionId);
    if (!guards.has(session.id)) throw new PolicyError('Use run cancellation to close a runner session');
    guards.delete(session.id); watchedDemoSessions.delete(session.id); await manager.closeSession(session.id); return { ok: true };
  });
  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/pages', async request => {
    if (!guards.has(request.params.sessionId)) throw new PolicyError('Runner sessions cannot be modified');
    return (await manager.createPage(request.params.sessionId)).info();
  });
  app.delete<{ Params: { sessionId: string; pageId: string } }>('/api/sessions/:sessionId/pages/:pageId', async request => {
    const page = manualPage(request.params.pageId);
    if (page.sessionId !== request.params.sessionId) throw new PolicyError('Page belongs to another session');
    await page.page.close(); return { ok: true };
  });
  app.get<{ Params: { pageId: string } }>('/api/pages/:pageId/state', request => findPage(request.params.pageId).info());
  app.post<{ Params: { pageId: string } }>('/api/pages/:pageId/goto', async request => {
    const { url } = z.object({ url: z.string().min(1).max(4000) }).strict().parse(request.body);
    const page = manualPage(request.params.pageId); const guard = guards.get(page.sessionId)!;
    const destination = guard.checkURL(new URL(url, guard.environment.baseURL).href);
    await page.execute(() => page.page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
    return page.info();
  });
  app.post<{ Params: { pageId: string; action: string } }>('/api/pages/:pageId/mouse/:action', async request => {
    const page = manualPage(request.params.pageId);
    await page.execute(async () => {
      switch (request.params.action) {
        case 'move': { const value = move.parse(request.body); await page.mouse.move(value.x, value.y, value); break; }
        case 'click': { const value = click.parse(request.body); await page.mouse.click(value.x, value.y, value); break; }
        case 'doubleClick': { const value = click.parse(request.body); await page.mouse.doubleClick(value.x, value.y, value); break; }
        case 'down': case 'up': { const value = z.object({ button }).strict().parse(request.body ?? {}); await page.mouse[request.params.action](value.button); break; }
        case 'wheel': { const value = z.object({ deltaX: z.number().finite().min(-100000).max(100000).default(0), deltaY: z.number().finite().min(-100000).max(100000) }).strict().parse(request.body); await page.mouse.wheel(value.deltaX, value.deltaY); break; }
        case 'drag': { const value = z.object({ from: point, to: point, steps: z.number().int().min(1).max(120).default(20) }).strict().parse(request.body); await page.mouse.drag(value.from, value.to, { steps: value.steps }); break; }
        default: throw new Error('Unknown mouse action');
      }
    });
    return { ok: true, position: page.mouse.getPosition(), state: page.mouse.getState() };
  });
  app.post<{ Params: { pageId: string } }>('/api/pages/:pageId/keyboard', async request => {
    const value = z.discriminatedUnion('action', [z.object({ action: z.literal('type'), text: z.string().max(10000) }).strict(), z.object({ action: z.literal('press'), key: z.string().max(100) }).strict()]).parse(request.body);
    const page = manualPage(request.params.pageId);
    await page.execute(() => value.action === 'type' ? page.keyboard.type(value.text) : page.keyboard.press(value.key)); return { ok: true };
  });
  app.post('/api/demo', async () => {
    if (demoStarting) throw new Error('Demo is already starting');
    demoStarting = true;
    try {
      for (const id of watchedDemoSessions) { guards.delete(id); await manager.closeSession(id).catch(() => {}); }
      watchedDemoSessions.clear();
      const address = app.server.address();
      const port = address && typeof address === 'object' ? address.port : 3210;
      const demoEnvironment: TestEnvironment = { name: 'local', baseURL: `http://127.0.0.1:${port}`, production: false, allowedDomains: ['127.0.0.1', 'localhost'] };
      const ids = await startDemo(manager, bus, demoEnvironment, (id, guard) => { guards.set(id, guard); watchedDemoSessions.add(id); });
      return { sessionIds: ids };
    } finally { demoStarting = false; }
  });
  app.get('/debug/mouse', async (_req, reply) => reply.type('text/html').send(await readFile(resolve(root, 'src/fixtures/mouse.html'), 'utf8')));
  app.get('/debug/frame', async (_req, reply) => reply.type('text/html').send(await readFile(resolve(root, 'src/fixtures/frame.html'), 'utf8')));
  app.route({ method: ['GET','POST','DELETE','PUT','PATCH'], url: '/debug/echo', handler: request => ({ method: request.method, ok: true }) });
  await app.register(fastifyStatic, { root: artifactRoot, prefix: '/artifacts/', decorateReply: false, index: false, setHeaders: res => { res.header('Content-Disposition', 'attachment'); res.header('Cache-Control', 'no-store'); res.header('Content-Security-Policy', "sandbox; default-src 'none'"); } });
  if (options.ui !== false) {
    if (options.productionUI) {
      await app.register(fastifyStatic, { root: resolve(root, 'dist'), prefix: '/', decorateReply: true });
      app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
    } else {
      const { createServer } = await import('vite');
      vite = await createServer({ root, server: { middlewareMode: true, hmr: false, host: '127.0.0.1', fs: { strict: true } }, appType: 'spa' });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
        reply.hijack(); vite!.middlewares(request.raw, reply.raw, () => { reply.raw.statusCode = 404; reply.raw.end('Not found'); });
      });
    }
  }
  app.addHook('onClose', async () => { await scheduler.close(); await manager.close(); await vite?.close(); });
  return { app, bus, manager, scheduler, runner };
}
