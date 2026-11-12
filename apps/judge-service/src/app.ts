import { authUser } from '@cb/auth';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import { gauge } from '@cb/metrics';
import type { Infra } from './infra.js';
import { registerAdminRoutes } from './modules/drift/admin.routes.js';
import { registerSubmissionRoutes } from './modules/submissions/submissions.routes.js';
import { QUEUES } from './queues.js';

/** Plan §19 judge gauges, read from Postgres on each scrape (API process only). */
function registerJudgeGauges(infra: Infra) {
  gauge('judge_queue_depth', 'Submissions waiting or running', ['status'], async (g) => {
    for (const r of await infra.judging.queueDepth()) g.set({ status: r.status }, r.n);
  });
  gauge('judge0_budget_remaining', 'Judge0 calls left today', [], async (g) => {
    g.set((await infra.submissions.capacity()).remaining);
  });
  gauge(
    'judge0_breaker_open',
    'Judge0 breaker: 0 closed, 1 half-open, 2 open (any process)',
    [],
    async (g) => {
      const b = (await infra.submissions.capacity()).breaker;
      g.set(b === 'open' ? 2 : b === 'half_open' ? 1 : 0);
    },
  );
}

/** HTTP app: intake, results, languages, Judge0 callbacks, capacity. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
    openapi: { title: 'judge-service', version: '1.0.0' },
  });
  registerJudgeGauges(infra);
  // Callbacks and calibration views need profiles and instance limits in the API process too.
  await infra
    .bootstrapJudge0()
    .catch((err: unknown) => infra.logger.warn({ err }, 'Judge0 info unavailable at boot'));
  await infra.judging.loadProfiles();
  registerSubmissionRoutes(app, {
    submissions: infra.submissions,
    judging: infra.judging,
    calibrations: infra.calibrations,
    auth: infra.authHooks,
    idem: createIdempotency({ db: infra.db.db, getOwner: (req) => authUser(req).userId }),
    internalAuth: infra.internalAuth,
    limits: infra.limits,
  });
  registerAdminRoutes(app, {
    submissions: infra.submissions,
    drift: infra.drift,
    driftQueue: infra.queues[QUEUES.drift]!,
    auth: infra.authHooks,
  });
  await infra.drift.load();
  infra.relay.start();
  infra.dispatcher.start();
  return app;
}
