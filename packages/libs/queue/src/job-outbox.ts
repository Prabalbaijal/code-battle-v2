import { withTransaction, type Db, type Executor } from '@cb/db';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { currentTraceparent, runUntraced } from '@cb/telemetry';
import type { Queue } from 'bullmq';
import { asc, inArray, isNull } from 'drizzle-orm';
import { assertValidJobId } from './queue.js';
import { jobOutbox } from './schema.js';

export interface OutboxJob {
  queue: string;
  /** Business key; duplicates are ignored both here (unique index) and by BullMQ. */
  jobId: string;
  name: string;
  data: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
}

/** Record a job inside the caller's transaction. Idempotent per (queue, jobId). */
export async function addJobToOutbox(tx: Executor, job: OutboxJob): Promise<void> {
  assertValidJobId(job.jobId);
  await tx
    .insert(jobOutbox)
    .values({
      id: newId(),
      queue: job.queue,
      jobId: job.jobId,
      name: job.name,
      data: job.data,
      runAt: job.runAt ?? null,
      priority: job.priority ?? null,
      traceparent: currentTraceparent() ?? null,
    })
    .onConflictDoNothing();
}

export interface JobOutboxDispatcherOptions {
  db: Db;
  logger: Logger;
  queues: Record<string, Queue>;
  intervalMs?: number;
  batchSize?: number;
  now?: () => number;
}

/** Moves job_outbox rows into BullMQ after commit. Safe to run on many instances (SKIP LOCKED). */
export class JobOutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(private readonly o: JobOutboxDispatcherOptions) {
    this.intervalMs = o.intervalMs ?? 1000;
    this.batchSize = o.batchSize ?? 100;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  kick(): void {
    if (!this.stopped && !this.running) this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => {});
  }

  async dispatchBatch(): Promise<number> {
    return withTransaction(this.o.db, async (tx) => {
      const rows = await tx
        .select()
        .from(jobOutbox)
        .where(isNull(jobOutbox.dispatchedAt))
        .orderBy(asc(jobOutbox.createdAt))
        .limit(this.batchSize)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;
      for (const r of rows) {
        const queue = this.o.queues[r.queue];
        if (!queue) throw new Error(`no queue registered for "${r.queue}"`);
        const delay = r.runAt ? Math.max(0, r.runAt.getTime() - this.now()) : 0;
        const data = {
          ...(r.data as Record<string, unknown>),
          ...(r.traceparent ? { _traceparent: r.traceparent } : {}),
        };
        await queue.add(r.name, data, {
          jobId: r.jobId,
          delay,
          ...(r.priority === null ? {} : { priority: r.priority }),
        });
      }
      await tx
        .update(jobOutbox)
        .set({ dispatchedAt: new Date() })
        .where(
          inArray(
            jobOutbox.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    // Detached from request traces; jobs carry `_traceparent` so their spans still link up.
    this.timer = runUntraced(() =>
      setTimeout(() => {
        this.running = (async () => {
          try {
            while (!this.stopped && (await this.dispatchBatch()) === this.batchSize) {
              /* drain */
            }
          } catch (err) {
            this.o.logger.warn({ err }, 'job outbox dispatch failed; will retry');
          }
        })().finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.intervalMs);
        });
      }, delay),
    );
  }
}
