import { createHttpServer, type HttpServer } from '@cb/http-server';
import type { Infra } from './infra.js';
import { registerRatingRoutes } from './modules/rating.routes.js';

/** HTTP app: leaderboard and stats reads (all writes come from events, in the worker). */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
    openapi: { title: 'rating-service', version: '1.0.0' },
  });
  registerRatingRoutes(app, {
    stats: infra.stats,
    leaderboard: infra.leaderboard,
    auth: infra.authHooks,
    internalAuth: infra.internalAuth,
  });
  return app;
}
