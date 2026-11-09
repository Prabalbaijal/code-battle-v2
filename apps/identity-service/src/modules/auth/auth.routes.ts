import { authUser, parseCookies, type AuthHooks, type TokenSigner } from '@cb/auth';
import {
  AUTH_COOKIES,
  forgotPasswordBodySchema,
  loginBodySchema,
  meSchema,
  REFRESH_COOKIE_PATH,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionSchema,
  socketTicketSchema,
  tokenBodySchema,
} from '@cb/contracts';
import { AppError } from '@cb/errors';
import type { HttpServer } from '@cb/http-server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthController } from './auth.controller.js';
import { toSession } from './auth.controller.js';
import { enforceLimits, type AuthRateLimits } from './auth.rate-limits.js';
import type { ClientMeta, IssuedSession } from './auth.service.js';

export interface IdempotencyHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

export interface AuthRouteDeps {
  controller: AuthController;
  auth: AuthHooks;
  /** Idempotency for anonymous routes (owner = client IP). */
  idem: IdempotencyHooks;
  limits: AuthRateLimits;
  signer: TokenSigner;
  cookieSecure: boolean;
}

const BASE = '/api/v1/auth';
const okSchema = z.object({ ok: z.literal(true) });

const meta = (req: FastifyRequest): ClientMeta => ({
  ip: req.ip,
  ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
});

const refreshCookie = (req: FastifyRequest) => parseCookies(req.headers.cookie)[AUTH_COOKIES.refresh];

export function registerAuthRoutes(app: HttpServer, d: AuthRouteDeps): void {
  const { controller: c, auth, limits } = d;
  const base = { httpOnly: true, secure: d.cookieSecure, sameSite: 'lax' as const };

  const setSessionCookies = (reply: FastifyReply, s: IssuedSession) => {
    reply.setCookie(AUTH_COOKIES.access, s.access.token, {
      ...base,
      path: '/',
      expires: s.access.expiresAt,
    });
    reply.setCookie(AUTH_COOKIES.refresh, s.refresh.token, {
      ...base,
      path: REFRESH_COOKIE_PATH,
      expires: s.refresh.expiresAt,
    });
  };
  const clearSessionCookies = (reply: FastifyReply) => {
    reply.clearCookie(AUTH_COOKIES.access, { ...base, path: '/' });
    reply.clearCookie(AUTH_COOKIES.refresh, { ...base, path: REFRESH_COOKIE_PATH });
  };

  app.post(
    `${BASE}/register`,
    {
      schema: { body: registerBodySchema, response: { 201: meSchema } },
      preHandler: [
        auth.csrfGuard,
        async (req, reply) => enforceLimits(reply, [limits.registerIp, req.ip]),
        d.idem.preHandler,
      ],
      onSend: d.idem.onSend,
    },
    async (req, reply) => reply.code(201).send(await c.register(req.body)),
  );

  app.post(
    `${BASE}/login`,
    {
      schema: { body: loginBodySchema, response: { 200: sessionSchema } },
      preHandler: [
        auth.csrfGuard,
        async (req, reply) =>
          enforceLimits(
            reply,
            [limits.loginIp, req.ip],
            [
              limits.loginAccount,
              `${req.ip}|${(req.body as { identifier: string }).identifier.toLowerCase()}`,
            ],
          ),
      ],
    },
    async (req, reply) => {
      const session = await c.login(req.body, meta(req));
      setSessionCookies(reply, session);
      return toSession(session);
    },
  );

  app.post(
    `${BASE}/refresh`,
    {
      schema: { response: { 200: sessionSchema } },
      preHandler: [auth.csrfGuard, async (req, reply) => enforceLimits(reply, [limits.tokenIp, req.ip])],
    },
    async (req, reply) => {
      const raw = refreshCookie(req);
      if (!raw) throw new AppError('UNAUTHORIZED', 401, 'No refresh token');
      const out = await c.refresh(raw, meta(req));
      if (out.kind === 'race') {
        throw new AppError('CONFLICT', 409, 'Session was refreshed by another request; retry', {
          details: { retry: true },
        });
      }
      if (out.kind === 'invalid') {
        clearSessionCookies(reply);
        throw new AppError('TOKEN_INVALID', 401, 'Session expired. Please log in again.');
      }
      setSessionCookies(reply, out.session);
      return toSession(out.session);
    },
  );

  app.post(`${BASE}/logout`, { preHandler: [auth.csrfGuard] }, async (req, reply) => {
    await c.logout(refreshCookie(req));
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.post(`${BASE}/logout-all`, { preHandler: [auth.authenticate] }, async (req, reply) => {
    await c.logoutAll(authUser(req).userId);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.post(
    `${BASE}/verify-email`,
    {
      schema: { body: tokenBodySchema, response: { 200: z.object({ verified: z.literal(true) }) } },
      preHandler: [auth.csrfGuard, async (req, reply) => enforceLimits(reply, [limits.tokenIp, req.ip])],
    },
    async (req) => c.verifyEmail(req.body.token),
  );

  app.post(
    `${BASE}/resend-verification`,
    {
      schema: { response: { 202: z.object({ sent: z.boolean() }) } },
      preHandler: [
        auth.authenticate,
        async (req, reply) =>
          enforceLimits(
            reply,
            [limits.emailIp, req.ip],
            [limits.emailAccount, `user:${authUser(req).userId}`],
          ),
      ],
    },
    async (req, reply) => reply.code(202).send(await c.resendVerification(authUser(req).userId)),
  );

  app.post(
    `${BASE}/forgot-password`,
    {
      schema: { body: forgotPasswordBodySchema, response: { 200: okSchema } },
      preHandler: [
        auth.csrfGuard,
        async (req, reply) =>
          enforceLimits(
            reply,
            [limits.emailIp, req.ip],
            [limits.emailAccount, `email:${(req.body as { email: string }).email}`],
          ),
      ],
    },
    async (req) => c.forgotPassword(req.body.email),
  );

  app.post(
    `${BASE}/reset-password`,
    {
      schema: { body: resetPasswordBodySchema, response: { 200: okSchema } },
      preHandler: [auth.csrfGuard, async (req, reply) => enforceLimits(reply, [limits.tokenIp, req.ip])],
    },
    async (req, reply) => {
      const out = await c.resetPassword(req.body.token, req.body.password);
      clearSessionCookies(reply); // every session was revoked
      return out;
    },
  );

  app.get(
    `${BASE}/me`,
    { schema: { response: { 200: meSchema } }, preHandler: [auth.authenticate] },
    async (req) => c.me(authUser(req).userId),
  );

  app.post(
    `${BASE}/socket-ticket`,
    { schema: { response: { 200: socketTicketSchema } }, preHandler: [auth.authenticate] },
    async (req) => c.socketTicket(authUser(req).userId),
  );

  // Public keys for local JWT verification by the gateway, services and realtime nodes.
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return d.signer.publicJwks();
  });
}
