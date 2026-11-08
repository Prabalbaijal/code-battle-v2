import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import type { Infra } from './infra.js';
import { GreetingController } from './modules/greeting/greeting.controller.js';
import { actingUser, registerGreetingRoutes } from './modules/greeting/greeting.routes.js';

/** HTTP app. Starts the relay/dispatcher so events and jobs go out right after commit. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
  });
  const idem = createIdempotency({ db: infra.db.db, getOwner: actingUser });
  registerGreetingRoutes(app, new GreetingController(infra.greetings), idem);
  infra.relay.start();
  infra.dispatcher.start();
  return app;
}
