import { authUser, type AuthHooks } from '@cb/auth';
import {
  acceptChallengeResultSchema,
  activeMatchSchema,
  challengeSchema,
  createChallengeBodySchema,
  cursorQuerySchema,
  matchHistoryItemSchema,
  matchStateSchema,
  pageSchema,
  participationSchema,
  tabLeaseBodySchema,
  tabLeaseResultSchema,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChallengeService } from './challenges/challenges.service.js';
import type { MatchService } from './matches/matches.service.js';
import type { TabLeaseService } from './matches/tab-lease.js';

export interface IdempotencyHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

export interface BattleRouteDeps {
  challenges: ChallengeService;
  matches: MatchService;
  tabLease: TabLeaseService;
  auth: AuthHooks;
  idem: IdempotencyHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
}

const idParam = z.object({ id: z.uuid() });

export function registerBattleRoutes(app: HttpServer, d: BattleRouteDeps): void {
  const { auth } = d;
  const signedIn = [auth.authenticate];
  const player = [auth.authenticate, auth.requireVerified];

  // ---- challenges (plan §11.1) ----
  app.post(
    '/api/v1/challenges',
    {
      schema: { body: createChallengeBodySchema, response: { 201: challengeSchema } },
      preHandler: [...player, d.idem.preHandler],
      onSend: d.idem.onSend,
    },
    async (req, reply) =>
      reply.code(201).send(await d.challenges.create(authUser(req).userId, req.body.toUserId)),
  );
  app.get(
    '/api/v1/challenges',
    {
      schema: {
        querystring: z.object({ direction: z.enum(['incoming', 'outgoing']).default('incoming') }),
        response: { 200: z.object({ items: z.array(challengeSchema) }) },
      },
      preHandler: signedIn,
    },
    async (req) => ({ items: await d.challenges.list(authUser(req).userId, req.query.direction) }),
  );
  app.post(
    '/api/v1/challenges/:id/accept',
    {
      schema: { params: idParam, response: { 200: acceptChallengeResultSchema } },
      preHandler: [...player, d.idem.preHandler],
      onSend: d.idem.onSend,
    },
    async (req) => d.matches.accept(authUser(req).userId, req.params.id),
  );
  app.post(
    '/api/v1/challenges/:id/reject',
    { schema: { params: idParam, response: { 200: challengeSchema } }, preHandler: signedIn },
    async (req) => d.challenges.reject(authUser(req).userId, req.params.id),
  );
  app.post(
    '/api/v1/challenges/:id/cancel',
    { schema: { params: idParam, response: { 200: challengeSchema } }, preHandler: signedIn },
    async (req) => d.challenges.cancel(authUser(req).userId, req.params.id),
  );

  // ---- matches (plan §11.5, §11.6) ----
  app.get(
    '/api/v1/matches/active',
    {
      schema: { response: { 200: z.object({ match: activeMatchSchema.nullable() }) } },
      preHandler: signedIn,
    },
    async (req) => ({ match: await d.matches.active(authUser(req).userId) }),
  );
  app.get(
    '/api/v1/matches/history',
    {
      schema: { querystring: cursorQuerySchema, response: { 200: pageSchema(matchHistoryItemSchema) } },
      preHandler: signedIn,
    },
    async (req) => d.matches.history(authUser(req).userId, req.query.cursor, req.query.limit),
  );
  app.get(
    '/api/v1/matches/:id/state',
    { schema: { params: idParam, response: { 200: matchStateSchema } }, preHandler: signedIn },
    async (req) => d.matches.state(authUser(req).userId, req.params.id),
  );
  app.post(
    '/api/v1/matches/:id/forfeit',
    { schema: { params: idParam }, preHandler: signedIn },
    async (req, reply) => {
      await d.matches.forfeit(authUser(req).userId, req.params.id);
      return reply.code(204).send();
    },
  );

  // one tab per match (plan §13.5)
  app.post(
    '/api/v1/matches/:id/tab-lease',
    {
      schema: { params: idParam, body: tabLeaseBodySchema, response: { 200: tabLeaseResultSchema } },
      preHandler: signedIn,
    },
    async (req) => d.tabLease.acquire(authUser(req).userId, req.params.id, req.body.tabId, req.body.takeover),
  );

  // ---- internal: judge intake (plan §11.3) ----
  app.get(
    '/internal/matches/:id/participation',
    {
      schema: {
        params: idParam,
        querystring: z.object({ userId: z.uuid() }),
        response: { 200: participationSchema },
      },
      preHandler: [d.internalAuth],
    },
    async (req) => d.matches.participation(req.params.id, req.query.userId),
  );
}
