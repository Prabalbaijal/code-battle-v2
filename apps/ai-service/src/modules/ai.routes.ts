import { authUser, type AuthHooks } from '@cb/auth';
import {
  aiReviewSchema,
  aiStatusSchema,
  aiUsageSchema,
  hintListSchema,
  hintRequestSchema,
  hintSchema,
  integrityFlagPageSchema,
  integrityFlagSchema,
  integrityReviewSchema,
  noteSchema,
  noteSummarySchema,
  recommendationsSchema,
  tutorRequestSchema,
  type AiFeature,
  type TutorFrame,
} from '@cb/contracts';
import { AppError, isAppError } from '@cb/errors';
import type { HttpServer } from '@cb/http-server';
import type { Logger } from '@cb/logger';
import { z } from 'zod';
import type { ModelGateway } from '../llm/gateway.js';
import type { HintService } from './hints.service.js';
import type { IntegrityService } from './integrity.service.js';
import type { KnowledgeService } from './knowledge.service.js';
import type { RecommendationService } from './recommend.service.js';
import type { ReviewService } from './review.service.js';
import type { TutorService } from './tutor.service.js';

export interface AiRouteDeps {
  auth: AuthHooks;
  gateway: ModelGateway;
  features: AiFeature[];
  hintCosts: [number, number, number];
  reviews: ReviewService;
  hints: HintService;
  tutor: TutorService;
  knowledge: KnowledgeService;
  recommendations: RecommendationService;
  integrity: IntegrityService;
  logger: Logger;
}

const NEEDS_MODEL: AiFeature[] = ['review', 'hints', 'tutor'];

export function registerAiRoutes(app: HttpServer, d: AiRouteDeps): void {
  const { auth } = d;
  const on = (f: AiFeature) => d.features.includes(f) && (!NEEDS_MODEL.includes(f) || d.gateway.enabled);
  const feature = (f: AiFeature) => async () => {
    if (!on(f)) throw new AppError('AI_DISABLED', 503, 'This AI feature is switched off on this server.');
  };
  const player = [auth.authenticate, auth.requireVerified];

  app.get('/api/v1/ai/status', { schema: { response: { 200: aiStatusSchema } } }, async () => ({
    enabled: d.gateway.enabled,
    features: Object.fromEntries(
      (['review', 'hints', 'tutor', 'recommendations', 'integrity'] as AiFeature[]).map((f) => [f, on(f)]),
    ) as Record<AiFeature, boolean>,
    hintCosts: d.hintCosts,
  }));

  // ---- post-match coach ----
  app.post(
    '/api/v1/ai/reviews',
    {
      schema: { body: z.object({ matchId: z.uuid() }), response: { 202: aiReviewSchema } },
      preHandler: [...player, feature('review')],
    },
    async (req, reply) =>
      reply.code(202).send(await d.reviews.request(authUser(req).userId, req.body.matchId)),
  );
  app.get(
    '/api/v1/ai/reviews/:matchId',
    {
      schema: { params: z.object({ matchId: z.uuid() }), response: { 200: aiReviewSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => d.reviews.get(authUser(req).userId, req.params.matchId),
  );

  // ---- hints ----
  app.get(
    '/api/v1/ai/hints',
    {
      schema: { querystring: z.object({ problemId: z.uuid() }), response: { 200: hintListSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => ({ items: await d.hints.list(authUser(req).userId, req.query.problemId) }),
  );
  app.post(
    '/api/v1/ai/hints',
    {
      schema: { body: hintRequestSchema, response: { 200: hintSchema } },
      preHandler: [...player, feature('hints')],
    },
    async (req) => d.hints.get(authUser(req).userId, req.body),
  );

  // ---- tutor: server-sent events ----
  app.post(
    '/api/v1/ai/tutor',
    { schema: { body: tutorRequestSchema }, preHandler: [...player, feature('tutor')] },
    async (req, reply) => {
      const abort = new AbortController();
      req.raw.on('close', () => abort.abort());
      // errors up to here (match running, budget, provider down) are normal JSON errors
      const { frames } = await d.tutor.prepare(authUser(req).userId, req.body, abort.signal);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      const send = (f: TutorFrame) => reply.raw.write(`data: ${JSON.stringify(f)}\n\n`);
      try {
        for await (const f of frames) {
          if (abort.signal.aborted) break;
          send(f);
        }
      } catch (err) {
        d.logger.warn({ err }, 'tutor stream failed');
        send({
          type: 'error',
          code: isAppError(err) ? err.code : 'AI_UNAVAILABLE',
          message: isAppError(err) ? err.message : 'The tutor stopped unexpectedly.',
        });
      } finally {
        reply.raw.end();
      }
    },
  );

  // ---- learn: the DSA notes (public) ----
  app.get(
    '/api/v1/ai/notes',
    { schema: { response: { 200: z.object({ items: z.array(noteSummarySchema) }) } } },
    async () => ({ items: d.knowledge.noteSummaries() }),
  );
  app.get(
    '/api/v1/ai/notes/:slug',
    { schema: { params: z.object({ slug: z.string().max(80) }), response: { 200: noteSchema } } },
    async (req) => d.knowledge.note(req.params.slug),
  );

  // ---- recommendations ----
  app.get(
    '/api/v1/ai/recommendations',
    {
      schema: { response: { 200: recommendationsSchema } },
      preHandler: [auth.authenticate, feature('recommendations')],
    },
    async (req) => d.recommendations.get(authUser(req).userId),
  );

  // ---- admin: anti-cheat flags and AI usage ----
  const admin = [auth.authenticate, auth.requireRole('admin')];
  app.get(
    '/api/v1/admin/ai/flags',
    {
      schema: {
        querystring: z.object({ status: z.enum(['open', 'cleared', 'confirmed']).optional() }),
        response: { 200: integrityFlagPageSchema },
      },
      preHandler: admin,
    },
    async (req) => ({ items: await d.integrity.flags(req.query.status) }),
  );
  app.post(
    '/api/v1/admin/ai/flags/:id/review',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: integrityReviewSchema,
        response: { 200: integrityFlagSchema },
      },
      preHandler: admin,
    },
    async (req) => d.integrity.review(req.params.id, authUser(req).userId, req.body.status, req.body.note),
  );
  app.get(
    '/api/v1/admin/ai/usage',
    { schema: { response: { 200: aiUsageSchema } }, preHandler: admin },
    async () => d.integrity.usage(),
  );
}
