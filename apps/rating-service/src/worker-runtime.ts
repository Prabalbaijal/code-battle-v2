import { battleEvents, identityEvents, ratingEvents } from '@cb/contracts';
import { startLeaderLoop } from '@cb/db';
import { EventConsumer, on } from '@cb/events';
import { SERVICE_TOPICS, type Infra } from './infra.js';

export interface WorkerHandle {
  consumer: EventConsumer;
  stop(): Promise<void>;
}

/**
 * Background side: the event consumer (stats + ledger in the inbox transaction, then the ZSET
 * from our own `rating.stats.changed`), the outbox relay, and leaderboard maintenance.
 */
export async function startWorker(
  infra: Infra,
  opts: { fromBeginning?: boolean; maintenanceEveryMs?: number } = {},
): Promise<WorkerHandle> {
  const { logger, stats, leaderboard } = infra;
  const kick = () => setTimeout(() => infra.relay.kick(), 50).unref();
  const consumer = new EventConsumer({
    kafka: infra.kafka,
    db: infra.db.db,
    logger,
    groupId: infra.env.SERVICE_NAME,
    topics: SERVICE_TOPICS,
    handlers: [
      on(identityEvents.userRegisteredV1, async (tx, env) => {
        await stats.onRegistered(tx, env.data);
        kick();
      }),
      on(identityEvents.userRoleChangedV1, async (tx, env) => {
        await stats.onRoleChanged(tx, env.data);
        kick();
      }),
      on(battleEvents.matchCompletedV1, async (tx, env) => {
        await stats.onMatchCompleted(tx, env.data);
        kick();
      }),
      // committed already (it came from the outbox): safe to move the index now
      on(ratingEvents.statsChangedV1, async (_tx, env) => leaderboard.apply(env.data)),
    ],
    fromBeginning: opts.fromBeginning ?? false,
  });
  await consumer.start();
  infra.relay.start();

  // Plan §15: rebuild on boot and daily (leader-elected); any node that skipped a ZSET write
  // while Redis was down rebuilds as soon as Redis is back.
  await leaderboard.rebuild().catch((err) => logger.warn({ err }, 'boot rebuild failed'));
  const daily = startLeaderLoop({
    pool: infra.db.pool,
    name: 'rating-leaderboard-rebuild',
    intervalMs: infra.env.LEADERBOARD_REBUILD_INTERVAL_MS,
    logger,
    task: async () => {
      await leaderboard.rebuild();
    },
  });
  let repairing = false;
  const repair = setInterval(() => {
    if (repairing || !infra.safeRedis.available) return;
    repairing = true;
    void leaderboard
      .needsRebuild()
      .then((needed) => (needed ? leaderboard.rebuild() : false))
      .catch((err) => logger.warn({ err }, 'leaderboard repair failed'))
      .finally(() => (repairing = false));
  }, opts.maintenanceEveryMs ?? 10_000);
  repair.unref();

  return {
    consumer,
    async stop() {
      clearInterval(repair);
      await daily.stop();
      await consumer.stop();
    },
  };
}
