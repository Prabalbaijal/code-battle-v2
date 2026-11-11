import { generateSigningKey, JwtVerifier, TokenSigner } from '@cb/auth';
import type { HttpServer } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { RateLimiter } from '@cb/rate-limit';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import { startRedis, type Started } from '@cb/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEnv, type Env } from '../config/env.js';
import { buildGateway } from '../gateway.js';

const logger = createLogger({ service: 'gateway-int', level: 'silent' });
const WEB = 'https://codebattle.test';
let redisC: Started<{ url: string }>;
let redis: Redis;
let safeRedis: SafeRedis;
let signer: TokenSigner;
let identity: FastifyInstance;
let users: FastifyInstance;
let gw: HttpServer;
const gateways: HttpServer[] = [];
/** Requests that reached each fake upstream. */
const hits = { identity: 0, user: 0 };

interface Echo {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake upstream: echoes what it received, plus the few fixed routes the gateway needs. */
async function fakeUpstream(name: 'identity' | 'user'): Promise<FastifyInstance> {
  const app = Fastify();
  const echo = async (req: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    body: unknown;
  }) => {
    hits[name]++;
    return { method: req.method, url: req.url, headers: req.headers, body: req.body ?? null };
  };
  app.get('/health/ready', async () => ({ status: 'ok', checks: {} }));
  app.get('/openapi.json', async () => ({
    openapi: '3.0.3',
    info: { title: name, version: '1' },
    paths: {
      [`/api/v1/${name === 'identity' ? 'auth' : 'users'}/me`]: { get: {} },
      ...(name === 'user' ? { '/api/v1/friends': { get: {} }, '/internal/users/batch': { get: {} } } : {}),
      '/health/ready': { get: {} },
    },
  }));
  if (name === 'identity') {
    app.get('/.well-known/jwks.json', async () => signer.publicJwks());
    app.post('/api/v1/auth/login', async (req, reply) => {
      hits.identity++;
      reply.header('set-cookie', ['cb_at=abc; Path=/; HttpOnly', 'cb_rt=def; Path=/api/v1/auth; HttpOnly']);
      return echo(req);
    });
    app.all('/api/v1/auth/*', echo);
  } else {
    app.all('/api/v1/users/*', echo);
    app.all('/api/v1/friends', echo);
    app.all('/api/v1/friends/*', echo);
    app.all('/internal/*', echo);
    app.all('/api/v1/problems/*', echo);
    app.all('/api/v1/admin/problems', echo);
    app.all('/api/v1/admin/problems/*', echo);
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

const urlOf = (app: FastifyInstance) => {
  const a = app.server.address() as { port: number };
  return `http://127.0.0.1:${a.port}`;
};

async function gateway(overrides: Record<string, string> = {}): Promise<HttpServer> {
  const env: Env = readEnv({
    NODE_ENV: 'test',
    REDIS_URL: redisC.value.url,
    JWKS_URL: `${urlOf(identity)}/.well-known/jwks.json`,
    CORS_ORIGINS: WEB,
    TRUSTED_PROXIES: 'loopback',
    SERVICE_URL_IDENTITY: urlOf(identity),
    SERVICE_URL_USER: urlOf(users),
    SERVICE_URL_PROBLEM: urlOf(users),
    SERVICE_URL_JUDGE: urlOf(users),
    SERVICE_URL_BATTLE: urlOf(users),
    SERVICE_URL_REALTIME: urlOf(users),
    ...overrides,
  });
  const app = await buildGateway({
    env,
    logger,
    verifier: new JwtVerifier({ jwksUrl: env.JWKS_URL }),
    limiter: new RateLimiter({
      redis: safeRedis,
      logger,
      prefix: `gw-test-${randomUUID()}`,
      capacity: env.RATE_LIMIT_PER_IP_PER_MIN,
      refillPerSec: env.RATE_LIMIT_PER_IP_PER_MIN / 60,
    }),
    redisPing: safeRedis.ping,
  });
  gateways.push(app);
  return app;
}

beforeAll(async () => {
  redisC = await startRedis();
  redis = createRedis({ url: redisC.value.url, role: 'cache', logger, name: 'gw-test' });
  safeRedis = new SafeRedis(redis, logger);
  signer = await TokenSigner.create([await generateSigningKey('gw')]);
  [identity, users] = await Promise.all([fakeUpstream('identity'), fakeUpstream('user')]);
  gw = await gateway();
});

afterAll(async () => {
  await Promise.all(gateways.map((g) => g.close()));
  await Promise.all([identity?.close(), users?.close()]);
  redis?.disconnect();
  await redisC?.stop();
});

let ipSeq = 1;
const ip = () => `203.0.113.${ipSeq++ % 250}`;
const userToken = async (opts: { ev?: boolean; ttl?: number } = {}) => {
  const userId = randomUUID();
  const { token } = await signer.signAccess(
    { userId, role: 'user', emailVerified: opts.ev ?? true },
    opts.ttl ?? 900,
  );
  return { userId, token };
};

describe('proxying', () => {
  it('forwards method, path, query and body; sets trusted headers from the token only', async () => {
    const { userId, token } = await userToken();
    const res = await gw.inject({
      method: 'POST',
      url: '/api/v1/friends/requests?x=1',
      payload: { toUserId: 'abc' },
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-for': ip(),
        'x-user-id': 'spoofed',
        'x-user-role': 'admin',
        'x-internal-caller': 'evil',
        'x-request-id': 'req-123',
      },
    });
    expect(res.statusCode).toBe(200);
    const e = res.json() as Echo;
    expect(e).toMatchObject({
      method: 'POST',
      url: '/api/v1/friends/requests?x=1',
      body: { toUserId: 'abc' },
    });
    expect(e.headers).toMatchObject({
      'x-user-id': userId,
      'x-user-role': 'user',
      'x-user-verified': 'true',
    });
    expect(e.headers['x-internal-caller']).toBeUndefined();
    expect(e.headers['x-request-id']).toBe('req-123');
    expect(e.headers.authorization).toBe(`Bearer ${token}`); // services verify again (defence in depth)
    expect(res.headers['ratelimit-limit']).toBe('300');
  });

  it('forwards large bodies sent with expect: 100-continue (curl does this above 1 MB)', async () => {
    const { token } = await userToken();
    const res = await gw.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      payload: { toUserId: 'x'.repeat(200_000) },
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip(), expect: '100-continue' },
    });
    expect(res.statusCode).toBe(200);
    const e = res.json() as Echo;
    expect((e.body as { toUserId: string }).toUserId).toHaveLength(200_000);
    expect(e.headers.expect).toBeUndefined();
  });

  it('uses the last trusted hop as client IP (no XFF spoofing)', async () => {
    const res = await gw.inject({
      method: 'GET',
      url: '/api/v1/users/alice',
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' },
    });
    expect((res.json() as Echo).headers['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('passes Set-Cookie from identity through unchanged', async () => {
    const res = await gw.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {},
      headers: { 'x-forwarded-for': ip() },
    });
    expect(res.headers['set-cookie']).toEqual([
      'cb_at=abc; Path=/; HttpOnly',
      'cb_rt=def; Path=/api/v1/auth; HttpOnly',
    ]);
  });

  it('never exposes /internal, rejects traversal, 404s unknown routes', async () => {
    const before = hits.user;
    for (const url of [
      '/internal/users/batch',
      '/INTERNAL/users/batch',
      '/api/v1/users/../../internal/users/batch',
      '/api/v1/users/..%2f..%2finternal/users/batch',
      '/api/v1/users/%2e%2e/%2e%2e/internal/users/batch',
      '/api/v1/users/a%5c..%5cb', // encoded backslashes (inject itself turns a raw "\" into "/")
    ]) {
      const r = await gw.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip() } });
      expect([400, 404], url).toContain(r.statusCode);
    }
    expect(hits.user).toBe(before);
    const unknown = await gw.inject({
      method: 'GET',
      url: '/api/v1/battles',
      headers: { 'x-forwarded-for': ip() },
    });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('access rules', () => {
  it('role routes: problem authoring needs problem_setter (or admin) at the edge', async () => {
    const before = hits.user;
    const asUser = await userToken();
    const r = await gw.inject({
      method: 'GET',
      url: '/api/v1/admin/problems',
      headers: { authorization: `Bearer ${asUser.token}`, 'x-forwarded-for': ip() },
    });
    expect(r.statusCode).toBe(403);
    expect(hits.user).toBe(before);
    for (const role of ['problem_setter', 'admin'] as const) {
      const { token } = await signer.signAccess({ userId: randomUUID(), role, emailVerified: true }, 900);
      const ok = await gw.inject({
        method: 'GET',
        url: '/api/v1/admin/problems',
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip() },
      });
      expect([ok.statusCode, (ok.json() as Echo).headers['x-user-role']]).toEqual([200, role]);
    }
    const pub = await gw.inject({
      method: 'GET',
      url: '/api/v1/problems/two-sum',
      headers: { 'x-forwarded-for': ip() },
    });
    expect(pub.statusCode).toBe(200);
  });

  it('"user" routes: 401 before reaching the service without a valid token', async () => {
    const before = hits.user;
    expect(
      (await gw.inject({ method: 'GET', url: '/api/v1/friends', headers: { 'x-forwarded-for': ip() } }))
        .statusCode,
    ).toBe(401);
    const expired = await userToken({ ttl: -60 });
    const r = await gw.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: { authorization: `Bearer ${expired.token}`, 'x-forwarded-for': ip() },
    });
    expect([r.statusCode, r.json().error.details]).toEqual([401, { reason: 'expired' }]);
    const garbage = await gw.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: { authorization: 'Bearer x.y.z', 'x-forwarded-for': ip() },
    });
    expect(garbage.statusCode).toBe(401);
    expect(hits.user).toBe(before);
  });

  it('"optional" routes: a bad token is just anonymous', async () => {
    const expired = await userToken({ ttl: -60 });
    const r = await gw.inject({
      method: 'GET',
      url: '/api/v1/users/alice',
      headers: { authorization: `Bearer ${expired.token}`, 'x-forwarded-for': ip() },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as Echo).headers['x-user-id']).toBeUndefined();
  });

  it('"public" auth routes reach identity even with an expired access cookie (refresh must work)', async () => {
    const expired = await userToken({ ttl: -60 });
    const r = await gw.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `cb_at=${expired.token}; cb_rt=r`, 'x-cb-csrf': '1', 'x-forwarded-for': ip() },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as Echo).url).toBe('/api/v1/auth/refresh');
  });
});

describe('CSRF, Origin and CORS', () => {
  it('cookie-authenticated mutations need x-cb-csrf; bearer ones do not', async () => {
    const { token } = await userToken();
    const noHeader = await gw.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      payload: {},
      headers: { cookie: `cb_at=${token}`, 'x-forwarded-for': ip() },
    });
    expect(noHeader.statusCode).toBe(403);
    const ok = await gw.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      payload: {},
      headers: { cookie: `cb_at=${token}`, 'x-cb-csrf': '1', 'x-forwarded-for': ip() },
    });
    expect(ok.statusCode).toBe(200);
    const csrfOnAuth = await gw.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: 'cb_rt=x', 'x-forwarded-for': ip() },
    });
    expect(csrfOnAuth.statusCode).toBe(403);
  });

  it('rejects mutations from foreign origins; answers preflight for the web origin', async () => {
    const evil = await gw.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {},
      headers: { origin: 'https://evil.example', 'x-forwarded-for': ip() },
    });
    expect([evil.statusCode, evil.json().error.message]).toEqual([403, 'Origin not allowed']);
    const good = await gw.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {},
      headers: { origin: WEB, 'x-forwarded-for': ip() },
    });
    expect(good.statusCode).toBe(200);
    expect(good.headers['access-control-allow-origin']).toBe(WEB);
    expect(good.headers['access-control-allow-credentials']).toBe('true');

    const preflight = await gw.inject({
      method: 'OPTIONS',
      url: '/api/v1/friends/requests',
      headers: {
        origin: WEB,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-cb-csrf,idempotency-key',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-cb-csrf');
    const foreign = await gw.inject({
      method: 'OPTIONS',
      url: '/api/v1/friends/requests',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limits and failures', () => {
  it('limits per client IP with RateLimit headers and Retry-After; health is exempt', async () => {
    const small = await gateway({ RATE_LIMIT_PER_IP_PER_MIN: '3' });
    const client = ip();
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        (
          await small.inject({
            method: 'GET',
            url: '/api/v1/users/alice',
            headers: { 'x-forwarded-for': client },
          })
        ).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await small.inject({
      method: 'GET',
      url: '/api/v1/users/alice',
      headers: { 'x-forwarded-for': client },
    });
    expect([limited.json().error.code, limited.headers['ratelimit-remaining']]).toEqual([
      'RATE_LIMITED',
      '0',
    ]);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (
        await small.inject({
          method: 'GET',
          url: '/api/v1/users/alice',
          headers: { 'x-forwarded-for': ip() },
        })
      ).statusCode,
    ).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect(
        (await small.inject({ method: 'GET', url: '/health/live', headers: { 'x-forwarded-for': client } }))
          .statusCode,
      ).toBe(200);
    }
  });

  it('a down service becomes 503 in the standard error format; /health/upstreams reports it', async () => {
    const dead = await gateway({ SERVICE_URL_USER: 'http://127.0.0.1:1' });
    const r = await dead.inject({
      method: 'GET',
      url: '/api/v1/users/alice',
      headers: { 'x-forwarded-for': ip() },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE', requestId: expect.any(String) } });
    const ups = await dead.inject({ method: 'GET', url: '/health/upstreams' });
    expect([ups.statusCode, ups.json().checks]).toEqual([
      503,
      { identity: 'ok', user: 'down', problem: 'ok', judge: 'ok', battle: 'ok', realtime: 'ok' },
    ]);
    expect((await gw.inject({ method: 'GET', url: '/health/upstreams' })).statusCode).toBe(200);
  });
});

describe('docs', () => {
  it('serves Swagger UI and per-service specs trimmed to public paths', async () => {
    const ui = await gw.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    const spec = (await gw.inject({ method: 'GET', url: '/docs/specs/user' })).json() as {
      paths: object;
      servers: object;
    };
    expect(Object.keys(spec.paths).sort()).toEqual(['/api/v1/friends', '/api/v1/users/me']);
    expect(spec.servers).toEqual([{ url: '/' }]);
    expect((await gw.inject({ method: 'GET', url: '/docs/specs/nope' })).statusCode).toBe(404);
  });
});
