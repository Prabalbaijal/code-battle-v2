import { authUser, type AuthHooks } from '@cb/auth';
import {
  avatarUploadSignatureSchema,
  profilePageSchema,
  profileSchema,
  profileViewSchema,
  searchQuerySchema,
  updateProfileBodySchema,
  USERNAME_RE,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import type { RateLimiter } from '@cb/rate-limit';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforceLimit } from '../../lib/rate-limit.js';
import { toProfile } from './profile.dto.js';
import type { ProfileService } from './profile.service.js';

export interface ProfileRouteDeps {
  service: ProfileService;
  auth: AuthHooks;
  searchLimiter: RateLimiter;
  /** Preconfigured internal-auth preHandler, or undefined when INTERNAL_SERVICE_SECRET isn't set. */
  internalAuth?: (req: FastifyRequest) => Promise<void>;
}

const BASE = '/api/v1/users';

export function registerProfileRoutes(app: HttpServer, d: ProfileRouteDeps): void {
  const { service: s, auth } = d;

  app.get(
    `${BASE}/me`,
    { schema: { response: { 200: profileSchema } }, preHandler: [auth.authenticate] },
    async (req) => toProfile(await s.me(authUser(req).userId)),
  );

  app.patch(
    `${BASE}/me`,
    {
      schema: { body: updateProfileBodySchema, response: { 200: profileSchema } },
      preHandler: [auth.authenticate],
    },
    async (req) => toProfile(await s.update(authUser(req).userId, req.body)),
  );

  app.post(
    `${BASE}/me/avatar/upload-signature`,
    { schema: { response: { 200: avatarUploadSignatureSchema } }, preHandler: [auth.authenticate] },
    async (req) => s.avatarUploadSignature(authUser(req).userId),
  );

  app.get(
    `${BASE}/search`,
    {
      schema: {
        querystring: searchQuerySchema,
        response: { 200: profilePageSchema.extend({ fuzzy: z.boolean() }) },
      },
      preHandler: [
        auth.authenticate,
        async (req, reply) => enforceLimit(reply, d.searchLimiter, authUser(req).userId),
      ],
    },
    async (req) => {
      const r = await s.search(req.query.q, req.query.cursor, req.query.limit);
      return { items: r.items.map(toProfile), nextCursor: r.nextCursor, fuzzy: r.fuzzy };
    },
  );

  // Public profile; `relationship` is included when the viewer is logged in.
  app.get(
    `${BASE}/:username`,
    {
      schema: {
        params: z.object({ username: z.string().regex(USERNAME_RE) }),
        response: { 200: profileViewSchema },
      },
      preHandler: [auth.optionalAuth],
    },
    async (req) => {
      const { profile, relationship } = await s.byUsername(req.params.username, req.auth?.userId);
      return { ...toProfile(profile), ...(relationship ? { relationship } : {}) };
    },
  );

  // Service-to-service (gateway BFF, battle, realtime). Never routed by the gateway.
  if (d.internalAuth) {
    app.get(
      '/internal/users/batch',
      {
        schema: {
          querystring: z.object({
            ids: z
              .string()
              .transform((v) => v.split(',').filter(Boolean))
              .pipe(z.array(z.uuid()).min(1).max(100)),
          }),
          response: { 200: z.object({ items: z.array(profileSchema) }) },
        },
        preHandler: [d.internalAuth],
      },
      async (req) => ({ items: (await s.batch(req.query.ids)).map(toProfile) }),
    );
  }
}
