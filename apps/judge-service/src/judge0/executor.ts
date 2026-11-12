import { counter, histogram } from '@cb/metrics';
import { createHttpClient, UpstreamError, type HttpClient } from '@cb/http-client';
import type { InstanceLimits, RequestLimits, RunResult } from '@cb/judge-core';
import { CircuitBreaker, type BreakerState } from '@cb/resilience';
import { z } from 'zod';

/** Plan §14.10: swap Judge0 for a self-hosted runner later without touching the pipeline. */
export interface ExecRequest {
  languageId: number;
  sourceCode: string;
  stdin: string;
  limits: RequestLimits;
  callbackUrl?: string;
}

export interface ExecInfo {
  instance: InstanceLimits;
  maxBatch: number;
  languages: { id: number; name: string }[];
}

export interface CodeExecutor {
  info(): Promise<ExecInfo>;
  /** Tokens in request order; null for an item Judge0 rejected (e.g. a limit above its maximum). */
  submitBatch(reqs: ExecRequest[]): Promise<(string | null)[]>;
  fetchBatch(tokens: string[]): Promise<(RunResult & { token: string })[]>;
  readonly breakerState: BreakerState;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string | null | undefined) =>
  s == null ? null : Buffer.from(s, 'base64').toString('utf8');
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

const resultSchema = z.object({
  token: z.string(),
  status: z.object({ id: z.number() }),
  time: z.union([z.string(), z.number()]).nullish(),
  wall_time: z.union([z.string(), z.number()]).nullish(),
  memory: z.number().nullish(),
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
  compile_output: z.string().nullish(),
  message: z.string().nullish(),
});

/** Judge0 result → judge-core RunResult (base64 decoded; seconds as numbers). Shared with callbacks. */
export function normalizeResult(raw: unknown, base64 = true): RunResult & { token: string } {
  const r = resultSchema.parse(raw);
  const text = base64 ? unb64 : (s: string | null | undefined) => s ?? null;
  return {
    token: r.token,
    statusId: r.status.id,
    time: num(r.time),
    wallTime: num(r.wall_time),
    memoryKb: r.memory ?? null,
    stdout: text(r.stdout),
    stderr: text(r.stderr),
    compileOutput: text(r.compile_output),
    message: text(r.message),
  };
}

const BREAKER_RESET_MS = 30_000;

/** Plan §19: every Judge0 call (they cost quota), by operation and outcome, and how long it took. */
const calls = counter('judge0_calls_total', 'Judge0 API calls', ['op', 'result']);
const callSeconds = histogram('judge0_call_duration_seconds', 'Judge0 API call duration', ['op']);
async function timed<T>(op: 'submit' | 'fetch', fn: () => Promise<T>): Promise<T> {
  const end = callSeconds.startTimer({ op });
  try {
    const out = await fn();
    calls.inc({ op, result: 'ok' });
    return out;
  } catch (err) {
    calls.inc({ op, result: (err as Error).name === 'CircuitOpenError' ? 'breaker_open' : 'error' });
    throw err;
  } finally {
    end();
  }
}
const FIELDS = 'token,status,time,wall_time,memory,stdout,stderr,compile_output,message';

export interface Judge0Options {
  baseUrl: string;
  auth: 'none' | 'rapidapi' | 'token';
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Breaker transitions (to share them with the other judge processes). */
  onBreakerChange?: (to: BreakerState, openUntil: Date | null) => void;
}

export class Judge0HttpExecutor implements CodeExecutor {
  private readonly http: HttpClient;
  readonly breaker: CircuitBreaker;

  constructor(o: Judge0Options) {
    // 4xx are our bugs or quota, not an outage: they don't trip the breaker.
    this.breaker = new CircuitBreaker({
      name: 'judge0',
      failureThreshold: 5,
      resetTimeoutMs: BREAKER_RESET_MS,
      isFailure: (e) => !(e instanceof UpstreamError) || e.retryable,
      onStateChange: (_from, to) =>
        o.onBreakerChange?.(to, to === 'open' ? new Date(Date.now() + BREAKER_RESET_MS) : null),
    });
    const headers: Record<string, string> = {};
    if (o.auth === 'rapidapi') {
      headers['x-rapidapi-key'] = o.apiKey!;
      headers['x-rapidapi-host'] = new URL(o.baseUrl).host;
    }
    if (o.auth === 'token') headers['x-auth-token'] = o.apiKey!;
    this.http = createHttpClient({
      name: 'judge0',
      baseUrl: o.baseUrl,
      timeoutMs: 10_000,
      retries: 2,
      breaker: this.breaker,
      headers,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    });
  }

  get breakerState(): BreakerState {
    return this.breaker.currentState;
  }

  async info(): Promise<ExecInfo> {
    const [cfg, langs] = await Promise.all([
      this.http.request({ path: '/config_info', schema: z.record(z.string(), z.unknown()) }),
      this.http.request({
        path: '/languages',
        schema: z.array(z.object({ id: z.number(), name: z.string() })),
      }),
    ]);
    const c = cfg.data;
    const n = (k: string, fallback: number) => (typeof c[k] === 'number' ? (c[k] as number) : fallback);
    return {
      instance: {
        maxCpuSec: n('max_cpu_time_limit', 15),
        maxWallSec: n('max_wall_time_limit', 20),
        maxMemKb: n('max_memory_limit', 256_000),
        maxStackKb: n('max_stack_limit', 128_000),
        maxFileKb: n('max_max_file_size', 4096),
      },
      maxBatch: n('max_submission_batch_size', 20),
      languages: langs.data,
    };
  }

  async submitBatch(reqs: ExecRequest[]): Promise<(string | null)[]> {
    const res = await timed('submit', () =>
      this.http.request({
        method: 'POST',
        path: '/submissions/batch',
        query: { base64_encoded: true },
        // POST isn't idempotent: retrying could double-spend quota, so no automatic retry here.
        retry: false,
        body: {
          submissions: reqs.map((r) => ({
            source_code: b64(r.sourceCode),
            language_id: r.languageId,
            stdin: b64(r.stdin),
            ...r.limits,
            ...(r.callbackUrl ? { callback_url: r.callbackUrl } : {}),
          })),
        },
        schema: z.array(z.object({ token: z.string().optional() }).loose()),
      }),
    );
    return res.data.map((x) => x.token ?? null);
  }

  async fetchBatch(tokens: string[]): Promise<(RunResult & { token: string })[]> {
    if (!tokens.length) return [];
    const res = await timed('fetch', () =>
      this.http.request({
        path: '/submissions/batch',
        query: { tokens: tokens.join(','), base64_encoded: true, fields: FIELDS },
        schema: z.object({ submissions: z.array(z.unknown()) }),
      }),
    );
    return res.data.submissions.filter((s) => s !== null).map((s) => normalizeResult(s));
  }
}
