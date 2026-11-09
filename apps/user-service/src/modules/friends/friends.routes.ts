import { authUser, type AuthHooks } from '@cb/auth';
import {
  cursorQuerySchema,
  friendPageSchema,
  friendRequestBodySchema,
  friendRequestPageSchema,
  friendRequestResultSchema,
  friendRequestsQuerySchema,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { RateLimiter } from '@cb/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforceLimit } from '../../lib/rate-limit.js';
import { toProfile } from '../profile/profile.dto.js';
import type { FriendsService } from './friends.service.js';

export interface IdempotencyHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

export interface FriendsRouteDeps {
  service: FriendsService;
  auth: AuthHooks;
  idem: IdempotencyHooks;
  requestLimiter: RateLimiter;
}

const BASE = '/api/v1/friends';
const otherParam = z.object({ otherUserId: z.uuid() });

export function registerFriendsRoutes(app: HttpServer, d: FriendsRouteDeps): void {
  const { service: s, auth } = d;

  app.get(
    BASE,
    {
      schema: { querystring: cursorQuerySchema, response: { 200: friendPageSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => {
      const page = await s.list(authUser(req).userId, 'friends', req.query.cursor, req.query.limit);
      return {
        items: page.items.map((f) => ({ ...toProfile(f.profile), since: f.at.toISOString() })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    `${BASE}/requests`,
    {
      schema: { querystring: friendRequestsQuerySchema, response: { 200: friendRequestPageSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => {
      const { direction, cursor, limit } = req.query;
      const page = await s.list(authUser(req).userId, direction, cursor, limit);
      return {
        items: page.items.map((f) => ({
          user: toProfile(f.profile),
          direction,
          createdAt: f.at.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  // Verified email required (anti-spam); Idempotency-Key required (plan §7.3).
  app.post(
    `${BASE}/requests`,
    {
      schema: { body: friendRequestBodySchema, response: { 200: friendRequestResultSchema } },
      preHandler: [
        auth.authenticate,
        auth.requireVerified,
        async (req, reply) => enforceLimit(reply, d.requestLimiter, authUser(req).userId),
        d.idem.preHandler,
      ],
      onSend: d.idem.onSend,
    },
    async (req) => {
      const r = await s.sendRequest(authUser(req).userId, req.body.toUserId);
      return { status: r.status, user: toProfile(r.user) };
    },
  );

  app.post(
    `${BASE}/requests/:otherUserId/accept`,
    { schema: { params: otherParam }, preHandler: [auth.authenticate] },
    async (req, reply) => {
      await s.accept(authUser(req).userId, req.params.otherUserId);
      return reply.code(204).send();
    },
  );

  app.post(
    `${BASE}/requests/:otherUserId/reject`,
    { schema: { params: otherParam }, preHandler: [auth.authenticate] },
    async (req, reply) => {
      await s.reject(authUser(req).userId, req.params.otherUserId);
      return reply.code(204).send();
    },
  );

  /** Withdraw an outgoing request. */
  app.delete(
    `${BASE}/requests/:otherUserId`,
    { schema: { params: otherParam }, preHandler: [auth.authenticate] },
    async (req, reply) => {
      await s.cancel(authUser(req).userId, req.params.otherUserId);
      return reply.code(204).send();
    },
  );

  app.delete(
    `${BASE}/:otherUserId`,
    { schema: { params: otherParam }, preHandler: [auth.authenticate] },
    async (req, reply) => {
      await s.remove(authUser(req).userId, req.params.otherUserId);
      return reply.code(204).send();
    },
  );
}
