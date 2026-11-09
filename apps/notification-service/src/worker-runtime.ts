import { startLeaderLoop } from '@cb/db';
import { deadLetters } from '@cb/events';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import type { Worker } from 'bullmq';
import { lt, sql } from 'drizzle-orm';
import { fakeInbox } from './db/schema.js';
import type { Infra } from './infra.js';
import { emailSendProcessor } from './modules/email/email.jobs.js';
import { QUEUES } from './queues.js';

export interface WorkerHandle {
  emailWorker: Worker;
  stop(): Promise<void>;
}

/** Background side: the `email-send` worker (rate limited to the provider) and a fake-inbox sweeper. */
export async function startWorker(infra: Infra): Promise<WorkerHandle> {
  const { env, logger, db } = infra;

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
    async stop() {
      await leader.stop();
      await emailWorker.close();
    },
  };
}
