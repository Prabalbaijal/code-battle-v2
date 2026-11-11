import cors from '@fastify/cors';
import proxy, { type FastifyHttpProxyOptions } from '@fastify/http-proxy';
import swaggerUi from '@fastify/swagger-ui';
import { createAuthHooks, type AuthHooks, type JwtVerifier } from '@cb/auth';
import {
  CSRF_HEADER,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
  type ErrorBody,
  type ErrorCode,
} from '@cb/contracts';
import { AppError, forbidden } from '@cb/errors';
import { createHttpServer, type HttpServer } from '@cb/http-server';
import type { Logger } from '@cb/logger';
import type { RateLimiter } from '@cb/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { registerBff } from './bff.js';
import type { Env } from './config/env.js';
import {
  ROUTES,
  serviceUrls,
  TRUSTED_HEADERS,
  type Access,
  type RouteRule,
  type ServiceName,
} from './routes.js';

export interface GatewayDeps {
  env: Env;
  logger: Logger;
  verifier: JwtVerifier;
  limiter: RateLimiter;
  /** Readiness of the rate-limit store (non-critical: the limiter falls back to memory). */
  redisPing: () => Promise<boolean>;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HIDDEN = { schema: { hide: true } } as const;
/** Paths the gateway serves itself; they skip the per-IP limit. */
const OWN_PREFIXES = ['/health/', '/docs', '/openapi.json'];

const errorBody = (code: ErrorCode, message: string, requestId: string): ErrorBody => ({
  error: { code, message, requestId },
});

/** `..` segments, backslashes or encoded slashes could make the upstream see a different path. */
function isSuspiciousPath(rawPath: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return true; // malformed percent-encoding
  }
  return p.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(p) || /%2f|%5c/i.test(rawPath);
}

function accessHandler(auth: AuthHooks, access: Access) {
  switch (access) {
    // identity handles its own cookies (an expired access token must still reach /auth/refresh)
    case 'public':
      return [auth.csrfGuard];
    case 'optional':
      return [auth.optionalAuth];
    case 'user':
      return [auth.authenticate];
    case 'verified':
      return [auth.authenticate, auth.requireVerified];
    default:
      return [auth.authenticate, auth.requireRole(access)];
  }
}

/** Plan §8.1: the only internet-facing HTTP service. */
export async function buildGateway(d: GatewayDeps): Promise<HttpServer> {
  const { env, logger } = d;
  const urls = serviceUrls(env);
  const allowedOrigins = new Set(env.CORS_ORIGINS);

  const app = await createHttpServer({
    serviceName: env.SERVICE_NAME,
    logger,
    trustProxy: env.TRUSTED_PROXIES || false,
    readiness: { redis: d.redisPing },
    critical: [],
    openapi: {
      title: 'Code Battle gateway',
      description: 'Edge routes. Service APIs are listed in the selector.',
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      CSRF_HEADER,
      IDEMPOTENCY_HEADER,
      REQUEST_ID_HEADER,
      'traceparent',
    ],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'retry-after',
      'ratelimit-limit',
      'ratelimit-remaining',
      'idempotent-replayed',
    ],
    maxAge: 600,
  });

  // Edge checks for every request (after CORS preflight handling).
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?', 1)[0]!;
    if (isSuspiciousPath(path)) throw new AppError('BAD_REQUEST', 400, 'Invalid path');
    if (/^\/internal(\/|$)/i.test(path))
      throw new AppError('NOT_FOUND', 404, `Route ${req.method} ${path} not found`);
    if (OWN_PREFIXES.some((p) => path.startsWith(p))) return;

    // CSRF defence 1/2: browsers always send Origin on cross-site mutations (2/2 is x-cb-csrf).
    const origin = req.headers.origin;
    if (UNSAFE.has(req.method) && origin && !allowedOrigins.has(origin))
      throw forbidden('Origin not allowed');

    const r = await d.limiter.consume(`ip:${req.ip}`);
    reply.header('ratelimit-limit', String(env.RATE_LIMIT_PER_IP_PER_MIN));
    reply.header('ratelimit-remaining', String(Math.max(0, r.remaining)));
    if (!r.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Slow down.');
    }
  });

  const auth = createAuthHooks(d.verifier, { csrf: true });

  /** Never trust client-sent identity headers; set them only from a verified token. */
  const rewriteRequestHeaders = (req: FastifyRequest, headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const h: IncomingHttpHeaders = { ...headers };
    for (const name of TRUSTED_HEADERS) delete h[name];
    // curl and other clients send `expect: 100-continue` for big bodies; undici refuses to forward it
    delete h.expect;
    h['x-forwarded-for'] = req.ip;
    h['x-forwarded-proto'] = req.protocol;
    h[REQUEST_ID_HEADER] = req.id;
    if (req.auth) {
      h['x-user-id'] = req.auth.userId;
      h['x-user-role'] = req.auth.role;
      h['x-user-verified'] = String(req.auth.emailVerified);
    }
    return h;
  };

  const onUpstreamError = (
    reply: FastifyReply,
    { error }: { error: Error & { code?: string; statusCode?: number; cause?: { code?: string } } },
  ) => {
    // reply-from wraps network errors (e.g. FST_REPLY_FROM_INTERNAL_SERVER_ERROR with cause ECONNREFUSED)
    const codes = `${error.code ?? ''} ${error.cause?.code ?? ''}`;
    const timeout = error.statusCode === 504 || /TIMEOUT/i.test(codes);
    const down =
      /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT/i.test(codes);
    reply.log.warn({ err: error, codes }, 'upstream error');
    if (timeout)
      return reply.code(504).send(errorBody('UPSTREAM_ERROR', 'Upstream timed out', reply.request.id));
    if (down)
      return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Service unavailable', reply.request.id));
    return reply.code(502).send(errorBody('UPSTREAM_ERROR', 'Bad gateway', reply.request.id));
  };

  for (const rule of ROUTES) {
    const checks = accessHandler(auth, rule.access);
    // Fastify runs async preHandlers fine; the plugin's type only describes the callback style.
    const preHandler = (async (req: FastifyRequest) => {
      for (const check of checks) await check(req);
    }) as unknown as FastifyHttpProxyOptions['preHandler'];
    const options: FastifyHttpProxyOptions = {
      upstream: urls[rule.service],
      prefix: rule.prefix,
      rewritePrefix: rule.prefix,
      http2: false,
      preHandler,
      undici: {
        connections: 64,
        headersTimeout: env.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: env.UPSTREAM_TIMEOUT_MS,
      },
      replyOptions: {
        rewriteRequestHeaders: (req, headers) =>
          rewriteRequestHeaders(req as unknown as FastifyRequest, headers as IncomingHttpHeaders),
        onError: onUpstreamError as NonNullable<
          NonNullable<FastifyHttpProxyOptions['replyOptions']>['onError']
        >,
      },
    };
    await app.register(proxy, options);
  }

  // aggregation endpoints the gateway answers itself (the profile page)
  registerBff(app, { urls, auth, timeoutMs: Math.min(env.UPSTREAM_TIMEOUT_MS, 5000) });
  registerOps(app, urls);
  await registerDocs(app, urls);
  return app;
}

/** GET /health/upstreams: readiness of every service (for dashboards and smoke tests). */
function registerOps(app: HttpServer, urls: Record<ServiceName, string>) {
  app.get('/health/upstreams', HIDDEN, async (_req, reply) => {
    const entries = await Promise.all(
      (Object.entries(urls) as [ServiceName, string][]).map(async ([name, url]) => {
        const ok = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false);
        return [name, ok ? 'ok' : 'down'] as const;
      }),
    );
    const checks = Object.fromEntries(entries);
    const down = Object.values(checks).includes('down');
    return reply.code(down ? 503 : 200).send({ status: down ? 'degraded' : 'ok', checks });
  });
}

interface OpenApiDoc {
  paths?: Record<string, unknown>;
  servers?: unknown;
  [k: string]: unknown;
}

/**
 * /docs: Swagger UI over every service's /openapi.json, trimmed to the paths the gateway exposes
 * (no /internal, health or JWKS routes). Specs are cached for a minute.
 */
async function registerDocs(app: HttpServer, urls: Record<ServiceName, string>) {
  const services = [...new Set(ROUTES.map((r) => r.service))];
  const prefixesOf = (s: ServiceName) =>
    ROUTES.filter((r: RouteRule) => r.service === s).map((r) => r.prefix);
  const cache = new Map<ServiceName, { at: number; doc: OpenApiDoc }>();

  app.get('/docs/specs/:service', HIDDEN, async (req, reply) => {
    const service = (req.params as { service: string }).service as ServiceName;
    if (!services.includes(service)) throw new AppError('NOT_FOUND', 404, 'Unknown service');
    const hit = cache.get(service);
    if (hit && Date.now() - hit.at < 60_000) return hit.doc;
    let raw: OpenApiDoc;
    try {
      const res = await fetch(`${urls[service]}/openapi.json`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      raw = (await res.json()) as OpenApiDoc;
    } catch (err) {
      req.log.warn({ err, service }, 'openapi fetch failed');
      return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', `${service} docs unavailable`, req.id));
    }
    const allowed = prefixesOf(service);
    const paths = Object.fromEntries(
      Object.entries(raw.paths ?? {}).filter(([p]) =>
        allowed.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)),
      ),
    );
    const doc = { ...raw, servers: [{ url: '/' }], paths };
    cache.set(service, { at: Date.now(), doc });
    return doc;
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      urls: services.map((s) => ({ url: `/docs/specs/${s}`, name: `${s}-service` })),
      deepLinking: true,
      persistAuthorization: false,
    },
  });
}
