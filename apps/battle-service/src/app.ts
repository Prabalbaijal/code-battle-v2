import { authUser } from '@cb/auth';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import type { Infra } from './infra.js';
import { registerBattleRoutes } from './modules/battle.routes.js';

/** HTTP app: challenges, matches, and the participation check judge-service calls. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
    openapi: { title: 'battle-service', version: '1.0.0' },
  });
  registerBattleRoutes(app, {
    challenges: infra.challenges,
    matches: infra.matches,
    tabLease: infra.tabLease,
    auth: infra.authHooks,
    idem: createIdempotency({ db: infra.db.db, getOwner: (req) => authUser(req).userId }),
    internalAuth: infra.internalAuth,
  });
  infra.relay.start();
  infra.dispatcher.start();
  return app;
}
