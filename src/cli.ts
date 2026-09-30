import './config/load-env.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserManager } from './browser/BrowserManager.js';
import { EventBus } from './realtime/EventBus.js';
import { TestDefinitionSchema } from './shared/test-schema.js';
import { TestRunner } from './runner/TestRunner.js';
import { loadEnvironments } from '../config/environments.js';
const files = process.argv.slice(2).filter(value => !value.startsWith('--'));
if (!files.length) { console.error('Usage: npm run run:test -- examples/mouse-smoke.json [more.json] [--watch]'); process.exit(2); }
const bus = new EventBus();
const manager = new BrowserManager(bus, { executablePath: process.env.BROWSER_EXECUTABLE_PATH });
const artifactRoot = resolve('artifacts');
const runner = new TestRunner(manager, bus, { environments: loadEnvironments(), artifactRoot });
try {
  const tests = await Promise.all(files.map(async file => TestDefinitionSchema.parse(JSON.parse(await readFile(file, 'utf8')))));
  const { Scheduler } = await import('./scheduler/Scheduler.js');
  const scheduler = new Scheduler(runner, bus, { concurrency: Number(process.env.ENGINE_CONCURRENCY || 4) });
  const runs = tests.map(test => scheduler.submit(test, process.argv.includes('--watch') ? 'watch' : 'fast'));
  const results = await Promise.all(runs.map(run => scheduler.wait(run.id)));
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(resolve(artifactRoot, 'latest-report.json'), JSON.stringify(results, null, 2));
  for (const result of results) console.log(`${result.status.toUpperCase()}  ${result.name}  ${result.steps.length} steps${result.error ? ` — ${result.error}` : ''}`);
  process.exitCode = results.every(result => result.status === 'passed') ? 0 : 1;
  await scheduler.close();
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { await manager.close(); }
