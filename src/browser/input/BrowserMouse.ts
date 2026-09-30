import type { MouseButton, MousePosition, MouseState } from '../../shared/types.js';

export type { MouseButton, MousePosition, MouseState } from '../../shared/types.js';
export interface MoveOptions { steps?: number; durationMs?: number }
export interface ClickOptions { button?: MouseButton; clickCount?: number; delayMs?: number }
export interface BrowserMouse {
  getPosition(): MousePosition;
  getState(): MouseState;
  move(x: number, y: number, options?: MoveOptions): Promise<void>;
  click(x: number, y: number, options?: ClickOptions): Promise<void>;
  doubleClick(x: number, y: number, options?: Omit<ClickOptions, 'clickCount'>): Promise<void>;
  down(button?: MouseButton): Promise<void>;
  up(button?: MouseButton): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
  drag(from: MousePosition, to: MousePosition, options?: MoveOptions): Promise<void>;
  /** Mirror a successful semantic action without injecting elements into the target DOM. */
  syncPosition(x: number, y: number): void;
}
