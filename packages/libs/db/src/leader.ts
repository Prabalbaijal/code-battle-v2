import type { Logger } from '@cb/logger';
import type pg from 'pg';

export interface LeaderLoopOptions {
  pool: pg.Pool;
  /** Lock name; all instances using the same name compete for leadership. */
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  logger: Logger;
}

export interface LeaderLoop {
  isLeader(): boolean;
  stop(): Promise<void>;
}

/**
 * Leader election with a Postgres session advisory lock — no Redis needed (plan §11.4, §18.1).
 * The leader holds a dedicated connection; if the process or connection dies, Postgres releases
 * the lock and another instance takes over on its next tick.
 */
export function startLeaderLoop(opts: LeaderLoopOptions): LeaderLoop {
  let client: pg.PoolClient | undefined;
  let leader = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const release = async (destroy = false) => {
    const c = client;
    client = undefined;
    leader = false;
    if (!c) return;
    try {
      if (!destroy) await c.query('select pg_advisory_unlock(hashtext($1))', [opts.name]);
    } catch {
      destroy = true;
    }
    c.release(destroy);
  };

  const tick = async () => {
    try {
      if (!leader) {
        client = await opts.pool.connect();
        const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [
          opts.name,
        ]);
        if (res.rows[0]?.ok) {
          leader = true;
          opts.logger.info({ lock: opts.name }, 'acquired leadership');
        } else {
          await release();
        }
      } else {
        await client!.query('select 1'); // still connected ⇒ still holding the lock
      }
    } catch (err) {
      opts.logger.warn({ err, lock: opts.name }, 'leader election error');
      await release(true);
      return;
    }
    if (leader) {
      try {
        await opts.task();
      } catch (err) {
        opts.logger.error({ err, lock: opts.name }, 'leader task failed');
      }
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(schedule);
    }, opts.intervalMs);
  };
  running = tick().finally(schedule);

  return {
    isLeader: () => leader,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running.catch(() => {});
      await release();
    },
  };
}
