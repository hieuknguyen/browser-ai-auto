import type { EngineEvent, EventInput } from '../shared/types.js';
export class EventBus {
  private sequence = 0;
  private listeners = new Set<(event: EngineEvent) => void>();
  publish(input: EventInput): EngineEvent {
    const event = { ...input, sequence: ++this.sequence, timestamp: Date.now() } as EngineEvent;
    for (const listener of this.listeners) { try { listener(event); } catch { /* Observers cannot interrupt browser input. */ } }
    return event;
  }
  subscribe(listener: (event: EngineEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get listenerCount(): number { return this.listeners.size; }
}
