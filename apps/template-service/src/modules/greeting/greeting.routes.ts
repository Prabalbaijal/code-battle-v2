import type { HttpServer } from '@cb/http-server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GreetingController } from './greeting.controller.js';
import { createGreetingBody, greetingDto, greetingParams } from './greeting.schemas.js';

export interface IdempotencyHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

/**
 * Until Phase 1 adds JWT auth, the acting user comes from `x-user-id` (set by the gateway).
 * Real services read it from the verified token — never from the body.
 */
export const actingUser = (req: FastifyRequest): string => {
  const h = req.headers['x-user-id'];
  return typeof h === 'string' && h ? h : 'anonymous';
};

export function registerGreetingRoutes(
  app: HttpServer,
  controller: GreetingController,
  idem: IdempotencyHooks,
) {
  app.post(
    '/api/v1/greetings',
    {
      schema: { body: createGreetingBody, response: { 201: greetingDto } },
      preHandler: idem.preHandler,
      onSend: idem.onSend,
    },
    async (req, reply) => reply.code(201).send(await controller.create(actingUser(req), req.body)),
  );

  app.get(
    '/api/v1/greetings/:id',
    { schema: { params: greetingParams, response: { 200: greetingDto } } },
    async (req) => controller.get(req.params.id),
  );
}
