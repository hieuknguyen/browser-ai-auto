export interface BrowserKeyboard {
  type(text: string, options?: { delayMs?: number }): Promise<void>;
  press(key: string): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}
