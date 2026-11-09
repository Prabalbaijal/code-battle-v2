import { startLeaderLoop } from '@cb/db';
import { idempotencyKeys } from '@cb/idempotency';
import { jobOutbox } from '@cb/queue';
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import type { Infra } from './infra.js';
import { tokensRepository } from './modules/auth/tokens.repository.js';

export interface WorkerHandle {
  /** One housekeeping pass (exposed for tests). */
  sweep(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Background side of identity: outbox relay + job dispatcher, and a leader-elected sweeper that
 * purges expired tokens, dispatched email jobs (their payload holds one-time links) and old
 * idempotency keys. identity consumes no Kafka topics.
 */
export async function startWorker(infra: Infra): Promise<WorkerHandle> {
  const { db, logger } = infra;

  const sweep = async () => {
    const t = await tokensRepository.purgeExpired(db.db);
    const jobs = await db.db
      .delete(jobOutbox)
      .where(
        and(
          isNotNull(jobOutbox.dispatchedAt),
          lt(jobOutbox.dispatchedAt, sql`now() - interval '10 minutes'`),
        ),
      )
      .returning({ id: jobOutbox.id });
    const idem = await db.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, sql`now()`))
      .returning({ key: idempotencyKeys.key });
    logger.info({ ...t, jobs: jobs.length, idempotencyKeys: idem.length }, 'identity sweep');
  };

  infra.relay.start();
  infra.dispatcher.start();

  const leader = startLeaderLoop({
    pool: db.pool,
    name: `${infra.env.SERVICE_NAME}-sweeper`,
    intervalMs: 15 * 60_000,
    logger,
    task: sweep,
  });

  return {
    sweep,
    async stop() {
      await leader.stop();
    },
  };
}
