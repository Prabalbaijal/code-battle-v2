import type { Db } from '@cb/db';
import { AppError, unavailable } from '@cb/errors';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { counter, histogram } from '@cb/metrics';
import type { z } from 'zod';
import { aiRequests } from '../db/schema.js';
import type { Budget } from './budget.js';
import {
  ProviderError,
  type ChatMessage,
  type ModelProvider,
  type ProviderRequest,
  type Usage,
} from './provider.js';

const requests = counter('ai_requests_total', 'Model calls', ['feature', 'model', 'status']);
const tokenCount = counter('ai_tokens_total', 'Model tokens', ['feature', 'model', 'type']);
const latency = histogram(
  'ai_latency_seconds',
  'Model call latency',
  ['feature', 'model'],
  [0.5, 1, 2, 4, 8, 16, 32],
);

export type Tier = 'fast' | 'strong';

export interface CallSpec {
  feature: string;
  tier: Tier;
  /** Counted against this player's daily quota; null for background work (e.g. ingestion). */
  userId: string | null;
  promptVersion: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
}

const estimate = (spec: CallSpec) =>
  Math.ceil(spec.messages.reduce((n, m) => n + m.content.length, 0) / 3.5) + spec.maxTokens;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every model call goes through here (plan §22.3): budget reservation, one retry on a short 429, a 5xx
 * or a failed JSON generation, fallback from the strong model to the fast one, schema validation of JSON answers, and an
 * `ai_requests` row + metrics per call. Callers never see provider errors, only AppErrors.
 */
export class ModelGateway {
  constructor(
    private readonly d: {
      provider: ModelProvider | null;
      db: Db;
      budget: Budget;
      models: Record<Tier, string>;
      logger: Logger;
    },
  ) {}

  get enabled(): boolean {
    return this.d.provider !== null;
  }

  private provider(): ModelProvider {
    if (!this.d.provider) throw unavailable('AI_DISABLED', 'AI features are switched off on this server.');
    return this.d.provider;
  }

  /** Plain text answer. */
  async text(spec: CallSpec): Promise<string> {
    return (await this.call(spec)).text;
  }

  /** JSON answer under a strict schema, validated again with zod (one retry on a bad shape). */
  async json<T>(
    spec: CallSpec,
    schema: { name: string; json: Record<string, unknown>; zod: z.ZodType<T> },
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const { text } = await this.call(spec, { name: schema.name, schema: schema.json });
      try {
        return schema.zod.parse(JSON.parse(text));
      } catch (err) {
        this.d.logger.warn({ err, feature: spec.feature, attempt }, 'model returned an invalid shape');
        if (attempt >= 2) throw unavailable('AI_UNAVAILABLE', 'The AI gave an unusable answer. Try again.');
      }
    }
  }

  /** Streamed text; usage is settled when the stream ends (or is abandoned). */
  async *stream(spec: CallSpec, signal?: AbortSignal): AsyncGenerator<string> {
    const provider = this.provider();
    const model = this.d.models[spec.tier];
    const est = estimate(spec);
    await this.d.budget.reserve(model, spec.userId, est);
    const started = Date.now();
    let usage: Usage | undefined;
    let produced = 0;
    let status = 'ok';
    let error: string | null = null;
    try {
      for await (const chunk of provider.stream(this.request(spec, model, undefined, signal))) {
        if (chunk.delta) {
          produced += chunk.delta.length;
          yield chunk.delta;
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      status = 'error';
      error = (err as Error).message;
      throw this.toAppError(err);
    } finally {
      const used = usage ?? {
        inputTokens: Math.ceil(est - spec.maxTokens),
        outputTokens: Math.ceil(produced / 4),
      };
      await this.finish(spec, model, est, used, started, status, error);
    }
  }

  private request(
    spec: CallSpec,
    model: string,
    json?: ProviderRequest['json'],
    signal?: AbortSignal,
  ): ProviderRequest {
    return {
      model,
      messages: spec.messages,
      maxTokens: spec.maxTokens,
      temperature: spec.temperature ?? 0.3,
      ...(json ? { json } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  private async call(spec: CallSpec, json?: ProviderRequest['json']): Promise<{ text: string }> {
    const provider = this.provider();
    const models = spec.tier === 'strong' ? [this.d.models.strong, this.d.models.fast] : [this.d.models.fast];
    let last: unknown;
    for (const model of models) {
      const est = estimate(spec);
      await this.d.budget.reserve(model, spec.userId, est);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const started = Date.now();
        try {
          const r = await provider.complete(this.request(spec, model, json));
          await this.finish(spec, model, est, r.usage, started, 'ok', null);
          return { text: r.text };
        } catch (err) {
          last = err;
          const pe = err instanceof ProviderError ? err : undefined;
          this.d.logger.warn({ err, feature: spec.feature, model, attempt }, 'model call failed');
          const shortWait = pe?.rateLimited && (pe.retryAfterSec ?? 99) <= 10;
          // Groq answers 400 json_validate_failed when the sampled JSON didn't fit the schema: worth a retry
          const badJson =
            pe?.status === 400 && /json_validate_failed|failed to generate json/i.test(pe.message);
          if (attempt === 1 && pe && (shortWait || badJson || pe.status >= 500 || pe.status === 0)) {
            await sleep(shortWait ? (pe.retryAfterSec ?? 1) * 1000 + 200 : 1000);
            continue;
          }
          await this.finish(
            spec,
            model,
            est,
            { inputTokens: 0, outputTokens: 0 },
            started,
            'error',
            String(err),
          );
          break; // next model, if any
        }
      }
    }
    throw this.toAppError(last);
  }

  private async finish(
    spec: CallSpec,
    model: string,
    est: number,
    usage: Usage,
    started: number,
    status: string,
    error: string | null,
  ) {
    const actual = usage.inputTokens + usage.outputTokens;
    requests.inc({ feature: spec.feature, model, status });
    tokenCount.inc({ feature: spec.feature, model, type: 'input' }, usage.inputTokens);
    tokenCount.inc({ feature: spec.feature, model, type: 'output' }, usage.outputTokens);
    latency.observe({ feature: spec.feature, model }, (Date.now() - started) / 1000);
    await this.d.budget.settle(model, spec.userId, est, actual).catch(() => undefined);
    await this.d.db
      .insert(aiRequests)
      .values({
        id: newId(),
        userId: spec.userId,
        feature: spec.feature,
        model,
        promptVersion: spec.promptVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Date.now() - started,
        status,
        error: error?.slice(0, 500) ?? null,
      })
      .catch((err: unknown) => this.d.logger.warn({ err }, 'ai_requests insert failed'));
  }

  private toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof ProviderError && err.rateLimited) {
      return unavailable('AI_UNAVAILABLE', 'The AI is busy right now. Try again in a minute.');
    }
    return unavailable('AI_UNAVAILABLE', 'The AI is unavailable right now. Try again later.');
  }
}
