import type { EngineEvent, MouseState, ViewportState } from '../shared/types';

export interface FrameSnapshot { data: string; viewport: ViewportState }
type Listener = (event: EngineEvent) => void;

// Frames and input have separate ordering: an old frame must not suppress a
// newer input update, or an independent page's cursor.
class EventStream {
  private listeners = new Set<Listener>();
  private sequences = new Map<string, number>();
  frames = new Map<string, FrameSnapshot>();
  cursors = new Map<string, Partial<MouseState>>();

  reset() {
    this.sequences.clear();
    this.frames.clear();
    this.cursors.clear();
  }

  publish(event: EngineEvent) {
    const family = event.type.startsWith('mouse:') ? 'mouse' : event.type;
    const key = `${event.pageId ?? event.sessionId ?? event.runId ?? 'engine'}:${family}`;
    if (typeof event.sequence === 'number') {
      if (event.sequence <= (this.sequences.get(key) ?? -1)) return;
      this.sequences.set(key, event.sequence);
    }
    if (event.pageId && event.type === 'browser:frame' && typeof event.data === 'string') {
      this.frames.set(event.pageId, { data: event.data, viewport: event.viewport as ViewportState });
    }
    if (event.pageId && event.type.startsWith('mouse:')) {
      this.cursors.set(event.pageId, {
        ...this.cursors.get(event.pageId),
        ...(typeof event.x === 'number' ? { x: event.x } : {}),
        ...(typeof event.y === 'number' ? { y: event.y } : {}),
        ...(typeof event.status === 'string' ? { status: event.status as MouseState['status'] } : {}),
        ...(typeof event.button === 'string' ? { button: event.button as MouseState['button'] } : {}),
        ...(event.type === 'mouse:up' ? { button: 'none' as const } : {}),
      });
    }
    if (event.type === 'page:closed' && event.pageId) {
      this.frames.delete(event.pageId);
      this.cursors.delete(event.pageId);
    }
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const eventStream = new EventStream();

export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Máy chủ trả về phản hồi không thể đọc được (${response.status}).`); }
  if (!response.ok) {
    const error = result as { error?: string; message?: string };
    throw new Error(error.message ?? error.error ?? `Yêu cầu thất bại (${response.status}).`);
  }
  return result as T;
}
