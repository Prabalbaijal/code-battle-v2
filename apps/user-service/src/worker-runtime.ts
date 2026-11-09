import { identityEvents } from '@cb/contracts';
import { startLeaderLoop } from '@cb/db';
import { EventConsumer, on } from '@cb/events';
import { idempotencyKeys } from '@cb/idempotency';
import { lt, sql } from 'drizzle-orm';
import { SERVICE_TOPICS, type Infra } from './infra.js';

export interface WorkerHandle {
  consumer: EventConsumer;
  stop(): Promise<void>;
}

/**
 * Background side: consumes identity registrations into profiles (exactly-once effect via the
 * inbox), runs the outbox relay, and sweeps expired idempotency keys.
 */
export async function startWorker(
  infra: Infra,
  opts: { fromBeginning?: boolean } = {},
): Promise<WorkerHandle> {
  const consumer = new EventConsumer({
    kafka: infra.kafka,
    db: infra.db.db,
    logger: infra.logger,
    groupId: infra.env.SERVICE_NAME,
    topics: SERVICE_TOPICS,
    handlers: [
      on(identityEvents.userRegisteredV1, (tx, env) => infra.profiles.createFromRegistration(tx, env.data)),
    ],
    fromBeginning: opts.fromBeginning ?? true,
  });
  await consumer.start();
  infra.relay.start();

  const leader = startLeaderLoop({
    pool: infra.db.pool,
    name: `${infra.env.SERVICE_NAME}-sweeper`,
    intervalMs: 60 * 60_000,
    logger: infra.logger,
    task: async () => {
      await infra.db.db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, sql`now()`));
    },
  });

  return {
    consumer,
    async stop() {
      await leader.stop();
      await consumer.stop();
    },
  };
}
