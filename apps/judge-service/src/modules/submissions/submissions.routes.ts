import { authUser, type AuthHooks } from '@cb/auth';
import {
  capacitySchema,
  createSubmissionBodySchema,
  languageInfoSchema,
  submissionSchema,
} from '@cb/contracts';
import { AppError, unauthorized } from '@cb/errors';
import type { HttpServer } from '@cb/http-server';
import type { RateLimiter } from '@cb/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JudgingService } from '../judging/judging.service.js';
import type { SubmissionService } from './submissions.service.js';

export interface IdempotencyHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

export interface SubmissionRouteDeps {
  submissions: SubmissionService;
  judging: JudgingService;
  auth: AuthHooks;
  idem: IdempotencyHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  /** Plan §17.2: Submit 1 per 5 s, Run 6 per minute, per user. */
  limits: { submit: RateLimiter; run: RateLimiter };
}

export function registerSubmissionRoutes(app: HttpServer, d: SubmissionRouteDeps): void {
  const { submissions: s, auth } = d;

  app.post(
    '/api/v1/submissions',
    {
      bodyLimit: 160 * 1024, // 64 KB code + 64 KB custom input, JSON-escaped
      schema: {
        body: createSubmissionBodySchema,
        response: { 202: z.object({ submissionId: z.uuid(), status: z.string() }) },
      },
      preHandler: [
        auth.authenticate,
        auth.requireVerified,
        async (req, reply) => {
          const mode = (req.body as { mode: 'submit' | 'run' }).mode;
          const r = await d.limits[mode].consume(authUser(req).userId);
          if (!r.allowed) {
            reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
            throw new AppError(
              'RATE_LIMITED',
              429,
              mode === 'submit' ? 'One submission every 5 seconds' : 'Too many runs',
            );
          }
        },
        d.idem.preHandler,
      ],
      onSend: d.idem.onSend,
    },
    async (req, reply) => reply.code(202).send(await s.create(authUser(req), req.body)),
  );

  app.get(
    '/api/v1/submissions/:id',
    {
      schema: { params: z.object({ id: z.uuid() }), response: { 200: submissionSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => s.get(authUser(req), req.params.id),
  );

  app.get(
    '/api/v1/submissions',
    {
      schema: {
        querystring: z.object({ problemId: z.uuid().optional(), matchId: z.uuid().optional() }),
        response: { 200: z.object({ items: z.array(submissionSchema) }) },
      },
      preHandler: [auth.authenticate],
    },
    async (req) => ({ items: await s.list(authUser(req), req.query) }),
  );

  app.get(
    '/api/v1/languages',
    { schema: { response: { 200: z.object({ items: z.array(languageInfoSchema) }) } } },
    async () => ({ items: await s.languages() }),
  );

  // Judge0 → us (callback mode). Authenticated by the HMAC in the URL plus the run's token.
  app.put(
    '/api/v1/hooks/judge0/:runId',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: { params: z.object({ runId: z.uuid() }), querystring: z.object({ sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const r = await d.judging.onCallback(req.params.runId, req.query.sig, req.body);
      if (r === 'rejected') throw unauthorized('Invalid callback');
      return reply.code(204).send();
    },
  );

  // battle-service admission control (plan §14.6)
  app.get(
    '/internal/capacity',
    { schema: { response: { 200: capacitySchema } }, preHandler: [d.internalAuth] },
    async () => s.capacity(),
  );
}
