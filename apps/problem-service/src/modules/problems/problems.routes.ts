import { authUser, type AuthHooks } from '@cb/auth';
import {
  adminProblemPageSchema,
  adminProblemSchema,
  createProblemBodySchema,
  cursorQuerySchema,
  judgeSpecSchema,
  publicProblemSchema,
  putTestFileBodySchema,
  referenceSolutionBodySchema,
  selectionBodySchema,
  selectionResultSchema,
  SLUG_RE,
  updateProblemBodySchema,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProblemService } from './problems.service.js';

export interface ProblemRouteDeps {
  service: ProblemService;
  auth: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
}

const ADMIN = '/api/v1/admin/problems';
const idParam = z.object({ id: z.uuid() });
const fileParam = idParam.extend({ ordinal: z.coerce.number().int().min(1).max(4) });
/** A 2 MB input + its output, JSON-escaped, fits comfortably. */
const TEST_FILE_BODY_LIMIT = 6 * 1024 * 1024;

export function registerProblemRoutes(app: HttpServer, d: ProblemRouteDeps): void {
  const { service: s, auth } = d;
  const setter = [auth.authenticate, auth.requireRole('problem_setter')];

  // ---- public ----
  app.get(
    '/api/v1/problems/:slug',
    {
      schema: {
        params: z.object({ slug: z.string().regex(SLUG_RE).max(80) }),
        response: { 200: publicProblemSchema },
      },
    },
    async (req) => s.publicBySlug(req.params.slug),
  );

  // ---- admin (problem_setter or admin; the gateway checks too) ----
  app.get(
    ADMIN,
    {
      schema: { querystring: cursorQuerySchema, response: { 200: adminProblemPageSchema } },
      preHandler: setter,
    },
    async (req) => s.list(req.query.cursor, req.query.limit),
  );
  app.post(
    ADMIN,
    { schema: { body: createProblemBodySchema, response: { 201: adminProblemSchema } }, preHandler: setter },
    async (req, reply) => reply.code(201).send(await s.create(authUser(req).userId, req.body)),
  );
  app.get(
    `${ADMIN}/:id`,
    { schema: { params: idParam, response: { 200: adminProblemSchema } }, preHandler: setter },
    async (req) => s.get(req.params.id),
  );
  app.patch(
    `${ADMIN}/:id`,
    {
      schema: { params: idParam, body: updateProblemBodySchema, response: { 200: adminProblemSchema } },
      preHandler: setter,
    },
    async (req) => s.update(req.params.id, req.body),
  );
  app.put(
    `${ADMIN}/:id/test-files/:ordinal`,
    {
      bodyLimit: TEST_FILE_BODY_LIMIT,
      schema: { params: fileParam, body: putTestFileBodySchema, response: { 200: adminProblemSchema } },
      preHandler: setter,
    },
    async (req) => s.putTestFile(req.params.id, req.params.ordinal, req.body),
  );
  app.delete(
    `${ADMIN}/:id/test-files/:ordinal`,
    { schema: { params: fileParam, response: { 200: adminProblemSchema } }, preHandler: setter },
    async (req) => s.deleteTestFile(req.params.id, req.params.ordinal),
  );
  app.post(
    `${ADMIN}/:id/reference-solutions`,
    {
      schema: { params: idParam, body: referenceSolutionBodySchema, response: { 201: adminProblemSchema } },
      preHandler: setter,
    },
    async (req, reply) => reply.code(201).send(await s.addReference(req.params.id, req.body)),
  );
  app.delete(
    `${ADMIN}/:id/reference-solutions/:refId`,
    {
      schema: { params: idParam.extend({ refId: z.uuid() }), response: { 200: adminProblemSchema } },
      preHandler: setter,
    },
    async (req) => s.deleteReference(req.params.id, req.params.refId),
  );
  app.post(
    `${ADMIN}/:id/publish`,
    { schema: { params: idParam, response: { 200: adminProblemSchema } }, preHandler: setter },
    async (req) => s.publish(req.params.id),
  );
  app.post(
    `${ADMIN}/:id/archive`,
    { schema: { params: idParam, response: { 200: adminProblemSchema } }, preHandler: setter },
    async (req) => s.archive(req.params.id),
  );

  // ---- internal (battle-service, judge-service) ----
  app.post(
    '/internal/selections',
    {
      schema: { body: selectionBodySchema, response: { 200: selectionResultSchema } },
      preHandler: [d.internalAuth],
    },
    async (req) => s.select(req.body.matchId, req.body.userIds, req.body.difficulty),
  );
  app.get(
    '/internal/problems/:id/judge-spec',
    { schema: { params: idParam, response: { 200: judgeSpecSchema } }, preHandler: [d.internalAuth] },
    async (req) => s.judgeSpec(req.params.id),
  );
  app.get(
    '/internal/blobs/sha256/:hex',
    {
      schema: { params: z.object({ hex: z.string().regex(/^[0-9a-f]{64}$/) }) },
      preHandler: [d.internalAuth],
    },
    async (req, reply) => {
      const bytes = await s.blob(`sha256/${req.params.hex}`);
      // content-addressed: safe to cache forever
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      reply.header('content-type', 'text/plain; charset=utf-8');
      return reply.send(bytes);
    },
  );
}
