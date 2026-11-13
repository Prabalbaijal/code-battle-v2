/**
 * The model provider behind ModelGateway (plan §22.3). Swapping Groq for another OpenAI-compatible
 * API (or Claude) means another implementation of this interface; nothing else changes.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Strict JSON-schema output (no streaming with it). */
  json?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  text: string;
  usage: Usage;
}

export interface StreamChunk {
  delta?: string;
  usage?: Usage;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
  stream(req: ProviderRequest): AsyncIterable<StreamChunk>;
}

/** A provider failure the gateway can act on: 429 (wait or give up) vs. a real error. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the provider asked us to wait (429 `retry-after`). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get rateLimited() {
    return this.status === 429;
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}
