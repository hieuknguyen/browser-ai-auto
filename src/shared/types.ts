export type ExecutionMode = 'fast' | 'watch';
export type MouseButton = 'left' | 'right' | 'middle';
export interface MousePosition { x: number; y: number }
export interface MouseState extends MousePosition {
  button: MouseButton | 'none';
  status: 'idle' | 'moving' | 'hovering' | 'pressed' | 'dragging';
}
export interface ViewportState { width: number; height: number; deviceScaleFactor: number; scrollX: number; scrollY: number }
export interface EngineEvent {
  type: string; sequence: number; timestamp: number;
  sessionId?: string; pageId?: string; runId?: string;
  [key: string]: unknown;
}
export type EventInput = Omit<EngineEvent, 'sequence' | 'timestamp'> & { type: string };
export interface PageInfo { id: string; sessionId: string; url: string; mouse: MouseState; viewport: ViewportState }
export interface SessionInfo { id: string; environment: string; mode: ExecutionMode; pages: PageInfo[]; runId?: string }
export interface AISettings {
  provider: 'gemini'; configured: boolean; model: string;
  apiUrl?: string;
  keyPreview?: string;
  keySource: 'environment' | 'session' | 'persisted' | 'none';
}
export interface AITaskStep {
  index: number; action: string; summary: string; status: string; error?: string;
  screenshot?: string;
}
export interface AITask {
  id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  instruction: string; startUrl: string; sessionId?: string; pageId?: string;
  steps: AITaskStep[]; answer?: string; error?: string; startedAt?: number; finishedAt?: number;
  artifacts?: { name: string; url: string }[];
}
export interface AIWorkflowItem {
  id: string; index: number; instruction: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  taskId?: string; answer?: string; error?: string; startedAt?: number; finishedAt?: number;
}
export interface AIWorkflow {
  id: string; name: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  items: AIWorkflowItem[]; startUrl: string; maxSteps: number; continueOnError: boolean;
  sessionId?: string; pageId?: string; activeIndex?: number; startedAt?: number;
  finishedAt?: number; error?: string; revision?: number;
}
export interface ProductionPolicy {
  enabled: boolean; maxConcurrency: number; requireTestAccount: boolean;
  testAccount?: string; blockedActions: string[]; blockedPathPatterns: string[];
  blockedMethods: string[]; requestsPerMinute: number;
}
export interface TestEnvironment {
  name: string; baseURL: string; production: boolean; allowedDomains: string[];
  policy?: ProductionPolicy;
}
export interface StepResult { index: number; action: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number; error?: string }
export interface RunResult {
  id: string; testId: string; name: string; environment: string; mode: ExecutionMode;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt?: number; finishedAt?: number; steps: StepResult[];
  artifacts: { name: string; url: string }[]; error?: string; sessionId?: string;
}
