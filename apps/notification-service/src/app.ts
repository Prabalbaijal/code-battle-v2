import { createHttpServer, type HttpServer } from '@cb/http-server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { fakeInbox } from './db/schema.js';
import type { Infra } from './infra.js';

const inboxQuery = z.object({
  to: z.email(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** HTTP app: health, plus the fake inbox reader when EMAIL_PROVIDER=fake (dev, E2E tests). */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping, redis: infra.safeRedis.ping },
    critical: ['db'],
  });

  // /internal/* is never routed by the gateway. The route only exists with the fake provider,
  // which env validation forbids in production.
  if (infra.env.EMAIL_PROVIDER === 'fake') {
    app.get('/internal/dev/inbox', { schema: { querystring: inboxQuery } }, async (req) => {
      const items = await infra.db.db
        .select()
        .from(fakeInbox)
        .where(eq(fakeInbox.to, req.query.to.toLowerCase()))
        .orderBy(desc(fakeInbox.createdAt))
        .limit(req.query.limit);
      return { items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) };
    });
  }
  return app;
}
