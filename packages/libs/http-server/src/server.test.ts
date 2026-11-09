import { AppError, conflict } from '@cb/errors';
import { createLogger } from '@cb/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpServer, type HttpServer } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
let app: HttpServer | undefined;
afterEach(async () => app?.close());

describe('createHttpServer', () => {
  it('maps AppError, validation errors, 404 and unknown errors to the error body', async () => {
    app = await createHttpServer({ serviceName: 't', logger });
    app.post('/x', { schema: { body: z.object({ n: z.number().int() }) } }, async () => {
      throw conflict('USER_IN_ACTIVE_MATCH', 'busy', { userId: 'u1' });
    });
    app.get('/boom', async () => {
      throw new Error('secret db detail');
    });
    app.get('/hidden', async () => {
      throw new AppError('INTERNAL_ERROR', 500, 'sensitive');
    });

    const c = await app.inject({ method: 'POST', url: '/x', payload: { n: 1 } });
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toMatchObject({
      code: 'USER_IN_ACTIVE_MATCH',
      message: 'busy',
      details: { userId: 'u1' },
    });
    expect(c.json().error.requestId).toBe(c.headers['x-request-id']);

    const v = await app.inject({ method: 'POST', url: '/x', payload: { n: 'no' } });
    expect(v.statusCode).toBe(400);
    expect(v.json().error.code).toBe('VALIDATION_FAILED');

    const nf = await app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);

    const b = await app.inject({ method: 'GET', url: '/boom' });
    expect(b.statusCode).toBe(500);
    expect(b.json().error.message).toBe('Internal error');

    const h = await app.inject({ method: 'GET', url: '/hidden' });
    expect(h.json().error.message).toBe('Internal error');
  });

  it('propagates a safe incoming x-request-id and replaces unsafe ones', async () => {
    app = await createHttpServer({ serviceName: 't', logger });
    const ok = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'a b<script>' },
    });
    expect(bad.headers['x-request-id']).not.toBe('a b<script>');
  });

  it('reports readiness: critical down → 503, non-critical down → degraded', async () => {
    app = await createHttpServer({
      serviceName: 't',
      logger,
      readiness: { db: async () => true, redis: async () => false },
      critical: ['db'],
    });
    const r1 = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ status: 'degraded', checks: { db: 'ok', redis: 'down' } });
    await app.close();

    app = await createHttpServer({ serviceName: 't', logger, readiness: { db: async () => false } });
    const r2 = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r2.statusCode).toBe(503);
  });

  it('enforces the body limit', async () => {
    app = await createHttpServer({ serviceName: 't', logger, bodyLimit: 32 });
    app.post('/big', async () => ({ ok: true }));
    const r = await app.inject({ method: 'POST', url: '/big', payload: { s: 'x'.repeat(100) } });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
