import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { ExecutionMode, EventInput, MouseButton, MousePosition, MouseState } from '../../shared/types.js';
import type { BrowserMouse, ClickOptions, MoveOptions } from './BrowserMouse.js';
import { OperationQueue } from '../OperationQueue.js';

type Emit = (event: EventInput) => void;
export class PlaywrightMouse implements BrowserMouse {
  private state: MouseState = { x: 0, y: 0, button: 'none', status: 'idle' };
  private readonly held = new Set<MouseButton>();

  constructor(
    private readonly page: Page,
    private readonly emit: Emit,
    private readonly mode: ExecutionMode = 'fast',
    private readonly queue = new OperationQueue(),
  ) {}

  getPosition(): MousePosition { return { x: this.state.x, y: this.state.y }; }
  getState(): MouseState { return { ...this.state }; }

  syncPosition(x: number, y: number): void {
    this.coordinates(x, y);
    this.state = { ...this.state, x, y, status: this.held.size ? 'dragging' : 'hovering' };
    this.publish('mouse:moved');
  }

  move(x: number, y: number, options: MoveOptions = {}): Promise<void> {
    return this.queue.run(() => this.moveInternal(x, y, options));
  }

  click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
    return this.queue.run(async () => {
      const button = options.button ?? 'left';
      this.button(button);
      const count = options.clickCount ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('clickCount must be between 1 and 3');
      const delayMs = options.delayMs ?? 0;
      this.duration(delayMs);
      await this.moveInternal(x, y, { steps: 1 });
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        await this.downInternal(button, clickCount);
        try {
          if (delayMs > 0) await delay(delayMs);
        } finally { await this.upInternal(button, clickCount); }
      }
    });
  }

  doubleClick(x: number, y: number, options: Omit<ClickOptions, 'clickCount'> = {}): Promise<void> {
    return this.click(x, y, { ...options, clickCount: 2 });
  }

  down(button: MouseButton = 'left'): Promise<void> { return this.queue.run(() => this.downInternal(button)); }
  up(button: MouseButton = 'left'): Promise<void> { return this.queue.run(() => this.upInternal(button)); }

  wheel(deltaX: number, deltaY: number): Promise<void> {
    return this.queue.run(async () => {
      this.coordinates(deltaX, deltaY);
      await this.page.mouse.wheel(deltaX, deltaY);
      this.publish('mouse:wheel', { deltaX, deltaY });
    });
  }

  drag(from: MousePosition, to: MousePosition, options: MoveOptions = {}): Promise<void> {
    return this.queue.run(async () => {
      await this.moveInternal(from.x, from.y, { steps: 1 });
      await this.downInternal('left');
      try { await this.moveInternal(to.x, to.y, { steps: this.mode === 'watch' ? 20 : 1, ...options }); }
      finally { await this.upInternal('left'); }
    });
  }

  private async moveInternal(x: number, y: number, options: MoveOptions): Promise<void> {
    this.coordinates(x, y);
    const steps = options.steps ?? (this.mode === 'watch' ? 8 : 1);
    if (!Number.isInteger(steps) || steps < 1 || steps > 1000) throw new Error('steps must be between 1 and 1000');
    const durationMs = options.durationMs ?? 0;
    this.duration(durationMs);
    if (this.mode === 'fast') {
      await this.page.mouse.move(x, y, { steps });
      this.state = { ...this.state, x, y, status: this.held.size ? 'dragging' : 'moving' };
      this.publish('mouse:moved');
    } else {
      const start = this.getPosition();
      const startedAt = Date.now();
      for (let index = 1; index <= steps; index++) {
        const remaining = startedAt + durationMs * index / steps - Date.now();
        if (remaining > 0) await delay(remaining);
        const next = { x: start.x + (x - start.x) * index / steps, y: start.y + (y - start.y) * index / steps };
        await this.page.mouse.move(next.x, next.y);
        this.state = { ...this.state, ...next, status: this.held.size ? 'dragging' : 'moving' };
        this.publish('mouse:moved');
      }
    }
    if (!this.held.size) this.state.status = 'hovering';
  }

  private async downInternal(button: MouseButton, clickCount = 1): Promise<void> {
    this.button(button);
    if (this.held.has(button)) throw new Error(`${button} mouse button is already pressed`);
    await this.page.mouse.down({ button, clickCount });
    this.held.add(button);
    this.state = { ...this.state, button, status: 'pressed' };
    this.publish('mouse:down', { button, clickCount });
  }

  private async upInternal(button: MouseButton, clickCount = 1): Promise<void> {
    this.button(button);
    await this.page.mouse.up({ button, clickCount });
    this.held.delete(button);
    this.state.button = [...this.held].at(-1) ?? 'none';
    this.state.status = this.held.size ? 'pressed' : 'hovering';
    this.publish('mouse:up', { button, clickCount });
  }

  private publish(type: string, extra: Record<string, unknown> = {}): void {
    this.emit({ type, ...this.getState(), state: this.getState(), ...extra });
  }
  private coordinates(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Mouse coordinates and deltas must be finite numbers');
  }
  private button(button: MouseButton): void {
    if (!['left', 'middle', 'right'].includes(button)) throw new Error('Unsupported mouse button');
  }
  private duration(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 30_000) throw new Error('Input duration must be between 0 and 30000 ms');
  }
}
