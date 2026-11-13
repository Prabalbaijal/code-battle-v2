import { authUser, type AuthHooks } from '@cb/auth';
import {
  coinChargeRequestSchema,
  coinChargeResultSchema,
  cursorQuerySchema,
  leaderboardSchema,
  ledgerPageSchema,
  myRankSchema,
  playerStatsSchema,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LeaderboardService } from './leaderboard.service.js';
import type { StatsService } from './stats.service.js';

export interface RatingRouteDeps {
  stats: StatsService;
  leaderboard: LeaderboardService;
  auth: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
}

export function registerRatingRoutes(app: HttpServer, d: RatingRouteDeps): void {
  const { auth } = d;

  // ---- leaderboard (plan §15): public; `me` and friends need a signed-in viewer ----
  app.get(
    '/api/v1/leaderboard',
    {
      schema: {
        querystring: z.object({ scope: z.enum(['global', 'friends']).default('global') }),
        response: { 200: leaderboardSchema },
      },
      preHandler: [auth.optionalAuth],
    },
    async (req) => {
      const viewer = req.auth?.userId;
      if (req.query.scope === 'friends') return d.leaderboard.friends(authUser(req).userId);
      return d.leaderboard.global(viewer);
    },
  );
  app.get(
    '/api/v1/leaderboard/me',
    { schema: { response: { 200: myRankSchema } }, preHandler: [auth.authenticate] },
    async (req) => d.leaderboard.me(authUser(req).userId),
  );

  // ---- stats ----
  app.get(
    '/api/v1/stats/me/ledger',
    {
      schema: {
        querystring: cursorQuerySchema.extend({
          matchIds: z
            .string()
            .transform((v) => v.split(',').filter(Boolean))
            .pipe(z.array(z.uuid()).max(100))
            .optional(),
        }),
        response: { 200: ledgerPageSchema },
      },
      preHandler: [auth.authenticate],
    },
    async (req) =>
      d.stats.ledger(authUser(req).userId, {
        cursor: req.query.cursor,
        limit: req.query.limit,
        matchIds: req.query.matchIds,
      }),
  );
  app.get(
    '/api/v1/stats/:userId',
    { schema: { params: z.object({ userId: z.uuid() }), response: { 200: playerStatsSchema } } },
    async (req) => d.stats.get(req.params.userId),
  );

  // ---- internal (service token; never routed by the gateway) ----
  // ai-service charges for hints in a battle (plan §22.2)
  app.post(
    '/internal/charges',
    {
      schema: { body: coinChargeRequestSchema, response: { 200: coinChargeResultSchema } },
      preHandler: [d.internalAuth],
    },
    async (req) => d.stats.charge(req.body),
  );
}
