import cookie from '@fastify/cookie';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import type { Infra } from './infra.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';

/** HTTP app. Starts the relay/dispatcher so events and jobs go out right after commit. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
  });
  await app.register(cookie);

  registerAuthRoutes(app, {
    controller: new AuthController(infra.auth),
    auth: infra.authHooks,
    // Registration is anonymous, so idempotency keys are scoped to the client IP.
    idem: createIdempotency({ db: infra.db.db, getOwner: (req) => `ip:${req.ip}` }),
    limits: infra.limits,
    signer: infra.signer,
    cookieSecure: infra.env.COOKIE_SECURE,
  });

  infra.relay.start();
  infra.dispatcher.start();
  return app;
}
