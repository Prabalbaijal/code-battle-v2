import type { Logger } from '@cb/logger';
import { withSpan } from '@cb/telemetry';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export type { Job };

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Job ids are business keys (e.g. `match-timeout-<matchId>`). Colons are reserved by BullMQ keys. */
export function assertValidJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(jobId)) {
    throw new Error(`invalid jobId "${jobId}": use [A-Za-z0-9_.-], no colons`);
  }
}

/** `connection` must be a Redis created with role "queue" (maxRetriesPerRequest: null, noeviction server). */
export function createQueue<T = unknown>(name: string, connection: Redis, defaults?: JobsOptions): Queue<T> {
  return new Queue<T>(name, { connection, defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...defaults } });
}

export interface CreateWorkerOptions<T> {
  name: string;
  connection: Redis;
  logger: Logger;
  /** `token` is the worker lock token (needed for `job.moveToDelayed` + `DelayedError`). */
  processor: (job: Job<T>, token?: string) => Promise<unknown>;
  concurrency?: number;
  /** Called once a job has exhausted all attempts (write a dead letter, alert, ...). */
  onExhausted?: (job: Job<T>, err: Error) => Promise<void>;
  limiter?: { max: number; duration: number };
}

/** Worker with tracing, structured logs and an exhausted-retries hook. Processors must be idempotent. */
export function createWorker<T>(opts: CreateWorkerOptions<T>): Worker<T> {
  const log = opts.logger.child({ queue: opts.name });
  const worker = new Worker<T>(
    opts.name,
    async (job, token) => {
      const traceparent = (job.data as { _traceparent?: string } | null)?._traceparent;
      return withSpan(
        `job ${opts.name}`,
        () => opts.processor(job, token),
        traceparent ? { traceparent } : undefined,
        {
          'job.id': job.id ?? '',
          'job.attempt': job.attemptsMade + 1,
        },
      );
    },
    {
      connection: opts.connection,
      concurrency: opts.concurrency ?? 5,
      ...(opts.limiter ? { limiter: opts.limiter } : {}),
    },
  );
  worker.on('failed', (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    log.warn({ err, jobId: job.id, attempt: job.attemptsMade, exhausted }, 'job failed');
    if (exhausted && opts.onExhausted) {
      opts
        .onExhausted(job, err)
        .catch((e: unknown) => log.error({ err: e, jobId: job.id }, 'onExhausted failed'));
    }
  });
  worker.on('error', (err) => log.error({ err }, 'worker error'));
  return worker;
}
