import { authUser } from '@cb/auth';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import type { Infra } from './infra.js';
import { registerFriendsRoutes } from './modules/friends/friends.routes.js';
import { registerProfileRoutes } from './modules/profile/profile.routes.js';

/** HTTP app. Starts the outbox relay so events go out right after commit. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
    openapi: { title: 'user-service', version: '1.0.0' },
  });

  registerProfileRoutes(app, {
    service: infra.profiles,
    auth: infra.authHooks,
    searchLimiter: infra.limits.search,
    ...(infra.internalAuth ? { internalAuth: infra.internalAuth } : {}),
  });
  registerFriendsRoutes(app, {
    service: infra.friends,
    auth: infra.authHooks,
    // runs after `authenticate`, so the key is scoped to the verified user
    idem: createIdempotency({ db: infra.db.db, getOwner: (req) => authUser(req).userId }),
    requestLimiter: infra.limits.friendRequests,
    ...(infra.internalAuth ? { internalAuth: infra.internalAuth } : {}),
  });

  infra.relay.start();
  return app;
}
