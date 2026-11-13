import type { Db, Executor } from '@cb/db';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { counter } from '@cb/metrics';
import { sql } from 'drizzle-orm';
import { aiTasks, type AiTaskRow } from '../db/schema.js';

export type TaskKind = AiTaskRow['kind'];

const outcomes = counter('ai_tasks_total', 'Background AI tasks', ['kind', 'outcome']);

/** Idempotent enqueue: the same (kind, key) is one task, however often it's asked for. */
export async function enqueueTask(
  ex: Executor,
  kind: TaskKind,
  key: string,
  payload: Record<string, unknown>,
  opts: { delayMs?: number; replace?: boolean } = {},
): Promise<void> {
  const runAfter = new Date(Date.now() + (opts.delayMs ?? 0));
  const q = ex.insert(aiTasks).values({ id: newId(), kind, key, payload, runAfter });
  if (opts.replace) {
    // e.g. a problem edited again: run it again (unless it's running right now)
    await q.onConflictDoUpdate({
      target: [aiTasks.kind, aiTasks.key],
      set: { payload, status: 'pending', attempts: 0, runAfter, lastError: null, updatedAt: sql`now()` },
      setWhere: sql`${aiTasks.status} <> 'running'`,
    });
  } else {
    await q.onConflictDoNothing();
  }
}

export type TaskHandler = (task: AiTaskRow) => Promise<void>;

/**
 * Postgres as the queue (plan §18.1's degraded mode, here the only mode): claim due tasks with
 * FOR UPDATE SKIP LOCKED, so any number of workers share the table without double work; retry with
 * backoff; give up after `maxAttempts`. A task left "running" by a crashed worker is retried later.
 */
export class TaskRunner {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly d: {
      db: Db;
      logger: Logger;
      handlers: Partial<Record<TaskKind, TaskHandler>>;
      /** After the last attempt (e.g. mark a review as failed so the UI stops waiting). */
      onFailed?: (task: AiTaskRow, err: unknown) => Promise<void>;
      everyMs?: number;
      maxAttempts?: number;
      /** One at a time by default: the provider's per-minute token limit is small. */
      batch?: number;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.d.everyMs ?? 2000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run whatever is due now (also used by tests). Returns how many tasks ran. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      // tasks stuck in "running" for 10 minutes belonged to a worker that died
      await this.d.db.execute(sql`
        update ai_tasks set status = 'pending', updated_at = now()
        where status = 'running' and updated_at < now() - interval '10 minutes'`);
      const claimed = await this.d.db.execute<AiTaskRow & { run_after: Date }>(sql`
        update ai_tasks set status = 'running', attempts = attempts + 1, updated_at = now()
        where id in (
          select id from ai_tasks
          where status = 'pending' and run_after <= now()
          order by run_after
          limit ${this.d.batch ?? 1}
          for update skip locked)
        returning id, kind, key, payload, attempts`);
      for (const row of claimed.rows) await this.run(row);
      return claimed.rows.length;
    } catch (err) {
      this.d.logger.warn({ err }, 'task tick failed');
      return 0;
    } finally {
      this.busy = false;
    }
  }

  private async run(task: AiTaskRow): Promise<void> {
    const handler = this.d.handlers[task.kind];
    const max = this.d.maxAttempts ?? 4;
    try {
      if (!handler) throw new Error(`no handler for ${task.kind}`);
      await handler(task);
      await this.d.db.execute(
        sql`update ai_tasks set status = 'done', updated_at = now() where id = ${task.id}`,
      );
      outcomes.inc({ kind: task.kind, outcome: 'done' });
    } catch (err) {
      const final = task.attempts >= max;
      const backoffSec = Math.min(30 * 2 ** (task.attempts - 1), 900);
      this.d.logger.warn(
        { err, task: task.kind, key: task.key, attempt: task.attempts, final },
        'task failed',
      );
      await this.d.db.execute(sql`
        update ai_tasks
        set status = ${final ? 'failed' : 'pending'},
            run_after = now() + make_interval(secs => ${backoffSec}),
            last_error = ${String((err as Error).message ?? err).slice(0, 500)},
            updated_at = now()
        where id = ${task.id}`);
      outcomes.inc({ kind: task.kind, outcome: final ? 'failed' : 'retry' });
      if (final) await this.d.onFailed?.(task, err).catch(() => undefined);
    }
  }
}
