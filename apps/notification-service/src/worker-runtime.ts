import { startLeaderLoop, type Tx } from '@cb/db';
import { battleEvents, ratingEvents, userEvents } from '@cb/contracts';
import { deadLetters, EventConsumer, on } from '@cb/events';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import type { Worker } from 'bullmq';
import { lt, sql } from 'drizzle-orm';
import { fakeInbox } from './db/schema.js';
import { SERVICE_TOPICS, type Infra } from './infra.js';
import { emailSendProcessor } from './modules/email/email.jobs.js';
import { QUEUES } from './queues.js';

export interface WorkerHandle {
  emailWorker: Worker;
  consumer: EventConsumer | undefined;
  stop(): Promise<void>;
}

/**
 * Background side: the `email-send` worker (rate limited to the provider), the in-app
 * notification consumer with its outbox relay, and a fake-inbox sweeper.
 */
export async function startWorker(
  infra: Infra,
  /** `inApp: false` runs email only (the email tests have no Kafka). */
  opts: { inApp?: boolean; fromBeginning?: boolean } = {},
): Promise<WorkerHandle> {
  const { env, logger, db } = infra;
  let consumer: EventConsumer | undefined;
  if (opts.inApp ?? true) {
    const n = infra.notifications;
    const kick = () => setTimeout(() => infra.relay.kick(), 50).unref();
    const handle =
      <T>(fn: (tx: Tx, e: T) => Promise<void>) =>
      async (tx: Tx, e: T) => {
        await fn(tx, e);
        kick();
      };
    consumer = new EventConsumer({
      kafka: infra.kafka,
      db: db.db,
      logger,
      groupId: env.SERVICE_NAME,
      topics: SERVICE_TOPICS,
      handlers: [
        on(
          userEvents.friendshipChangedV1,
          handle((tx, e) => n.onFriendship(tx, e)),
        ),
        on(
          battleEvents.challengeCreatedV1,
          handle((tx, e) => n.onChallengeCreated(tx, e.data)),
        ),
        on(
          battleEvents.challengeAcceptedV1,
          handle((tx, e) => n.onChallengeClosed(tx, e.data, 'accepted')),
        ),
        on(
          battleEvents.challengeRejectedV1,
          handle((tx, e) => n.onChallengeClosed(tx, e.data, 'rejected')),
        ),
        on(
          battleEvents.challengeCancelledV1,
          handle((tx, e) => n.onChallengeClosed(tx, e.data, 'cancelled')),
        ),
        on(
          battleEvents.challengeExpiredV1,
          handle((tx, e) => n.onChallengeClosed(tx, e.data, 'expired')),
        ),
        on(
          battleEvents.matchCompletedV1,
          handle((tx, e) => n.onMatchCompleted(tx, e.data)),
        ),
        on(
          ratingEvents.statsChangedV1,
          handle((tx, e) => n.onStatsChanged(tx, e.data)),
        ),
      ],
      fromBeginning: opts.fromBeginning ?? false,
    });
    await consumer.start();
    infra.relay.start();
  }

  const emailWorker = createWorker({
    name: QUEUES.email,
    connection: infra.queueRedis,
    logger,
    concurrency: 5,
    limiter: { max: env.EMAIL_RATE_PER_SEC, duration: 1000 },
    processor: emailSendProcessor(infra.email),
    onExhausted: async (job, err) => {
      const dedupeKey = (job.data as { dedupeKey?: unknown } | null)?.dedupeKey;
      if (typeof dedupeKey === 'string') await infra.email.giveUp(dedupeKey, err.message);
      // Keep the payload for replay but drop the address-bearing link from the dead letter.
      await db.db.insert(deadLetters).values({
        id: newId(),
        source: `bullmq:${QUEUES.email}`,
        payload: {
          jobId: job.id,
          dedupeKey,
          template: (job.data as { template?: unknown } | null)?.template,
        },
        error: String(err.stack ?? err),
        attempts: job.attemptsMade,
      });
    },
  });

  const leader = startLeaderLoop({
    pool: db.pool,
    name: `${env.SERVICE_NAME}-sweeper`,
    intervalMs: 60 * 60_000,
    logger,
    task: async () => {
      const r = await db.db
        .delete(fakeInbox)
        .where(lt(fakeInbox.createdAt, sql`now() - interval '1 day'`))
        .returning({ id: fakeInbox.id });
      if (r.length) logger.info({ purged: r.length }, 'fake inbox sweep');
    },
  });

  return {
    emailWorker,
    consumer,
    async stop() {
      await leader.stop();
      await consumer?.stop();
      await emailWorker.close();
    },
  };
}
