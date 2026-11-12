import { authUser } from '@cb/auth';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import { createIdempotency } from '@cb/idempotency';
import { gauge } from '@cb/metrics';
import { inArray, sql } from 'drizzle-orm';
import { matches } from './db/schema.js';
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
  // plan §19: matches being played or decided right now (read on each scrape)
  gauge('matches_active', 'Matches in progress or deciding', ['status'], async (g) => {
    const rows = await infra.db.db
      .select({ status: matches.status, n: sql<number>`count(*)::int` })
      .from(matches)
      .where(inArray(matches.status, ['in_progress', 'deciding']))
      .groupBy(matches.status);
    for (const status of ['in_progress', 'deciding'] as const) {
      g.set({ status }, rows.find((r) => r.status === status)?.n ?? 0);
    }
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
