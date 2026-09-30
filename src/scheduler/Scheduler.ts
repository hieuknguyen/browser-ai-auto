import { randomUUID } from 'node:crypto';
import type { EventBus } from '../realtime/EventBus';
import { TestDefinitionSchema, type TestDefinition } from '../shared/test-schema';
import type { ExecutionMode, RunResult } from '../shared/types';
import type { TestRunner } from '../runner/TestRunner';

interface Job { test: TestDefinition; result: RunResult; controller: AbortController; done: Promise<RunResult>; resolve: (result: RunResult) => void }

export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly active = new Map<string, Job>();
  private readonly unsubscribe: () => void;
  private readonly concurrency: number;
  private readonly historyLimit: number;
  private closed = false;

  constructor(private readonly runner: Pick<TestRunner, 'run' | 'environment'>, private readonly bus: EventBus, options: { concurrency?: number; historyLimit?: number } = {}) {
    this.concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency || 3)));
    this.historyLimit = Math.max(1, options.historyLimit || 200);
    this.unsubscribe = bus.subscribe(event => {
      if (event.type !== 'run:updated' || !event.run) return;
      const result = event.run as RunResult, job = this.jobs.get(result.id);
      if (job) job.result = structuredClone(result);
    });
  }

  submit(input: TestDefinition, mode: ExecutionMode = 'fast'): RunResult {
    if (this.closed) throw new Error('Scheduler is closed');
    if (this.queue.length >= 1_000) throw new Error('Run queue is full');
    const test = TestDefinitionSchema.parse(input);
    this.runner.environment(test.environment);
    const result: RunResult = { id: randomUUID(), testId: test.id, name: test.name, environment: test.environment, mode, status: 'queued', steps: [], artifacts: [] };
    let resolve!: (result: RunResult) => void;
    const done = new Promise<RunResult>(resolvePromise => { resolve = resolvePromise; });
    const job: Job = { test, result, controller: new AbortController(), done, resolve };
    this.jobs.set(result.id, job); this.queue.push(job);
    this.bus.publish({ type: 'run:updated', runId: result.id, run: structuredClone(result) });
    queueMicrotask(() => this.drain());
    return structuredClone(result);
  }

  list(): RunResult[] { return [...this.jobs.values()].map(job => structuredClone(job.result)).reverse(); }
  get(id: string): RunResult | undefined { const job = this.jobs.get(id); return job && structuredClone(job.result); }
  wait(id: string): Promise<RunResult> { const job = this.jobs.get(id); if (!job) return Promise.reject(new Error('Run not found')); return job.done.then(result => structuredClone(result)); }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running'].includes(job.result.status)) return false;
    job.controller.abort(new Error('Run cancelled'));
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      job.result = { ...job.result, status: 'cancelled', finishedAt: Date.now(), error: 'Run cancelled' };
      this.bus.publish({ type: 'run:updated', runId: id, run: structuredClone(job.result) });
      job.resolve(job.result); this.prune();
    }
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue, ...this.active.values()]) this.cancel(job.result.id);
    await Promise.all([...this.active.values()].map(job => job.done));
    this.unsubscribe();
  }

  private drain(): void {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      // A saturated production environment must not hold up independent local work.
      const index = this.queue.findIndex(job => {
        const environment = this.runner.environment(job.test.environment);
        if (!environment.production) return true;
        const count = [...this.active.values()].filter(active => active.test.environment === environment.name).length;
        return count < Math.max(1, environment.policy?.maxConcurrency ?? 1);
      });
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      if (!job) break;
      this.active.set(job.result.id, job);
      job.result = { ...job.result, status: 'running', startedAt: Date.now() };
      this.bus.publish({ type: 'run:updated', runId: job.result.id, run: structuredClone(job.result) });
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    try { job.result = await this.runner.run(job.test, { runId: job.result.id, mode: job.result.mode, signal: job.controller.signal }); }
    catch (error) { job.result = { ...job.result, status: job.controller.signal.aborted ? 'cancelled' : 'failed', finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }; }
    finally {
      this.active.delete(job.result.id);
      this.bus.publish({ type: 'run:updated', runId: job.result.id, run: structuredClone(job.result) });
      job.resolve(job.result); this.prune(); this.drain();
    }
  }

  private prune(): void {
    const completed = [...this.jobs.values()].filter(job => !['queued', 'running'].includes(job.result.status));
    for (const job of completed.slice(0, Math.max(0, completed.length - this.historyLimit))) this.jobs.delete(job.result.id);
  }
}
