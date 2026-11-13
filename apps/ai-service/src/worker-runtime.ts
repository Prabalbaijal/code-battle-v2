import { battleEvents, judgeEvents, problemEvents } from '@cb/contracts';
import { EventConsumer, on } from '@cb/events';
import { z } from 'zod';
import { SERVICE_TOPICS, type Infra } from './infra.js';
import { TaskRunner } from './lib/tasks.js';

export interface WorkerHandle {
  consumer: EventConsumer;
  tasks: TaskRunner;
  stop(): Promise<void>;
}

const reviewTask = z.object({ matchId: z.uuid(), userId: z.uuid() });
const integrityTask = z.object({ matchId: z.uuid() });
const ingestTask = z.object({ problemId: z.uuid(), slug: z.string() });

/**
 * Background side: read models from events (inbox-deduplicated), the Postgres task queue
 * (reviews, integrity checks, problem ingestion), and the notes index, refreshed on boot.
 */
export async function startWorker(
  infra: Infra,
  opts: { fromBeginning?: boolean; taskEveryMs?: number; ingestNotes?: boolean } = {},
): Promise<WorkerHandle> {
  const { logger, readModel } = infra;
  const consumer = new EventConsumer({
    kafka: infra.kafka,
    db: infra.db.db,
    logger,
    groupId: infra.env.SERVICE_NAME,
    topics: SERVICE_TOPICS,
    handlers: [
      on(problemEvents.problemPublishedV1, (tx, env) => readModel.onProblemPublished(tx, env.data)),
      on(problemEvents.problemUpdatedV1, (tx, env) => readModel.onProblemUpdated(tx, env.data)),
      on(battleEvents.matchStartedV1, (tx, env) => readModel.onMatchStarted(tx, env.data)),
      on(battleEvents.matchCompletedV1, (tx, env) => readModel.onMatchCompleted(tx, env.data)),
      on(battleEvents.matchAbortedV1, (tx, env) => readModel.onMatchAborted(tx, env.data)),
      on(judgeEvents.submissionJudgedV1, (tx, env) => readModel.onSubmissionJudged(tx, env.data)),
    ],
    // a new consumer group reads history too: every published problem and finished match counts
    fromBeginning: opts.fromBeginning ?? true,
  });
  await consumer.start();

  const tasks = new TaskRunner({
    db: infra.db.db,
    logger,
    everyMs: opts.taskEveryMs ?? 2000,
    handlers: {
      review: async (t) => {
        const p = reviewTask.parse(t.payload);
        await infra.reviews.process(p.matchId, p.userId);
      },
      integrity: async (t) => {
        await infra.integrity.check(integrityTask.parse(t.payload).matchId);
      },
      ingest_problem: async (t) => {
        const p = ingestTask.parse(t.payload);
        await infra.knowledge.ingestProblem(p.problemId, p.slug);
      },
    },
    onFailed: async (t, err) => {
      if (t.kind === 'review') {
        const p = reviewTask.parse(t.payload);
        await infra.reviews.fail(p.matchId, p.userId, err);
      }
    },
  });
  tasks.start();

  if (opts.ingestNotes ?? true) {
    // the first run downloads the embedding model; don't hold up the worker for it
    void infra.knowledge
      .ingestNotes()
      .then((n) => logger.info({ changed: n }, 'notes indexed'))
      .catch((err: unknown) =>
        logger.warn({ err }, 'notes indexing failed (the tutor answers without them)'),
      );
  }

  return {
    consumer,
    tasks,
    async stop() {
      tasks.stop();
      await consumer.stop();
    },
  };
}
