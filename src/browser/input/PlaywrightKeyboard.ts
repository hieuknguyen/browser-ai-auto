import type { Page } from 'playwright';
import type { EventInput } from '../../shared/types.js';
import { OperationQueue } from '../OperationQueue.js';
import type { BrowserKeyboard } from './BrowserKeyboard.js';

export class PlaywrightKeyboard implements BrowserKeyboard {
  constructor(private readonly page: Page, private readonly emit: (event: EventInput) => void, private readonly queue = new OperationQueue()) {}

  type(text: string, options: { delayMs?: number } = {}): Promise<void> {
    return this.queue.run(async () => {
      const delay = options.delayMs ?? 0;
      if (!Number.isFinite(delay) || delay < 0 || delay > 1000) throw new Error('Typing delay must be between 0 and 1000 ms');
      await this.page.keyboard.type(text, { delay });
      this.emit({ type: 'keyboard:typed', length: text.length });
    });
  }
  press(key: string): Promise<void> {
    return this.queue.run(async () => { await this.page.keyboard.press(key); this.emit({ type: 'keyboard:pressed', key }); });
  }
  down(key: string): Promise<void> {
    return this.queue.run(async () => { await this.page.keyboard.down(key); this.emit({ type: 'keyboard:down', key }); });
  }
  up(key: string): Promise<void> {
    return this.queue.run(async () => { await this.page.keyboard.up(key); this.emit({ type: 'keyboard:up', key }); });
  }
}
