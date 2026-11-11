import type { AuthHooks } from '@cb/auth';
import {
  onlinePageSchema,
  onlinePlayerSchema,
  presenceQueryBodySchema,
  presenceQueryResultSchema,
  type OnlinePlayer,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Directory } from './directory.js';
import type { PresenceStore } from './presence.js';

export interface PresenceRouteDeps {
  store: PresenceStore;
  directory: Directory;
  auth: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
}

/**
 * Lobby presence (plan §13.3): pulled and paginated, never broadcast (v1 pushed the whole online
 * list to everyone on every change).
 */
export function registerPresenceRoutes(app: HttpServer, d: PresenceRouteDeps): void {
  const signedIn = [d.auth.authenticate];

  const withProfiles = async (ids: string[]): Promise<OnlinePlayer[]> => {
    const [people, statuses] = await Promise.all([d.directory.players(ids), d.store.statuses(ids)]);
    return ids
      .filter((id) => people.has(id))
      .map((id) => {
        const p = people.get(id)!;
        return {
          userId: id,
          username: p.username,
          fullname: p.fullname,
          avatarUrl: p.avatarUrl,
          status: statuses[id] ?? 'offline',
        };
      });
  };

  let cachedCount = { at: 0, n: 0 };

  app.get(
    '/api/v1/presence/online',
    {
      schema: {
        querystring: z.object({
          cursor: z.string().max(80).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: onlinePageSchema },
      },
      preHandler: signedIn,
    },
    async (req) => {
      const page = await d.store.onlinePage(req.query.cursor, req.query.limit);
      return { items: await withProfiles(page.userIds), nextCursor: page.nextCursor };
    },
  );
  app.get(
    '/api/v1/presence/online/search',
    {
      schema: {
        querystring: z.object({ prefix: z.string().trim().min(1).max(20) }),
        response: { 200: z.object({ items: z.array(onlinePlayerSchema) }) },
      },
      preHandler: signedIn,
    },
    async (req) => ({ items: await withProfiles(await d.store.search(req.query.prefix, 20)) }),
  );
  app.get(
    '/api/v1/presence/online/count',
    { schema: { response: { 200: z.object({ count: z.number() }) } }, preHandler: signedIn },
    async () => {
      // ZCARD is cheap, but every lobby polls it: cache for 5 s (plan §13.3)
      if (Date.now() - cachedCount.at > 5000) cachedCount = { at: Date.now(), n: await d.store.count() };
      return { count: cachedCount.n };
    },
  );
  app.post(
    '/api/v1/presence/query',
    {
      schema: { body: presenceQueryBodySchema, response: { 200: presenceQueryResultSchema } },
      preHandler: signedIn,
    },
    async (req) => ({ statuses: await d.store.statuses(req.body.userIds) }),
  );

  // battle-service: "is the opponent online?" before a challenge (plan §11.1)
  app.post(
    '/internal/presence/query',
    {
      schema: { body: presenceQueryBodySchema, response: { 200: presenceQueryResultSchema } },
      preHandler: [d.internalAuth],
    },
    async (req) => ({ statuses: await d.store.statuses(req.body.userIds) }),
  );
}
