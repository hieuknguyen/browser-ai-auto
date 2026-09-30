import { AsyncLocalStorage } from 'node:async_hooks';

/** One page's input must stay ordered, including nested runner/adapter operations. */
export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly scope = new AsyncLocalStorage<object>();
  private active: object | undefined;
  private closed = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Browser page is closed'));
    if (this.active && this.scope.getStore() === this.active) return operation();
    const result = this.tail.then(async () => {
      if (this.closed) throw new Error('Browser page is closed');
      const token = {};
      this.active = token;
      try { return await this.scope.run(token, operation); }
      finally { if (this.active === token) this.active = undefined; }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  close(): void { this.closed = true; }
}
