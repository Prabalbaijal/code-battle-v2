import { createHttpServer, type HttpServer } from '@cb/http-server';
import type { Infra } from './infra.js';
import { registerProblemRoutes } from './modules/problems/problems.routes.js';

/** HTTP app. Starts the outbox relay so events go out right after commit. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping },
    critical: ['db'],
    openapi: { title: 'problem-service', version: '1.0.0' },
  });
  registerProblemRoutes(app, {
    service: infra.problems,
    auth: infra.authHooks,
    internalAuth: infra.internalAuth,
  });
  infra.relay.start();
  return app;
}
