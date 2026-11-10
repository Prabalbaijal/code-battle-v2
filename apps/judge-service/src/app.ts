import { authUser } from '@cb/auth';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import type { Infra } from './infra.js';
import { registerSubmissionRoutes } from './modules/submissions/submissions.routes.js';

/** HTTP app: intake, results, languages, Judge0 callbacks, capacity. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
    openapi: { title: 'judge-service', version: '1.0.0' },
  });
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
  infra.relay.start();
  infra.dispatcher.start();
  return app;
}
