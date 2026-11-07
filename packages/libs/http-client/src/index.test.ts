import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpClient, UpstreamError } from './index.js';

let server: Server;
let base = '';
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '';
    hits[path] = (hits[path] ?? 0) + 1;
    if (path.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n: 1, q: path }));
    } else if (path === '/flaky') {
      if (hits[path]! < 3) res.writeHead(503).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"n":2}');
    } else if (path === '/limited') {
      if (hits[path] === 1) res.writeHead(429, { 'retry-after': '0' }).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"n":3}');
    } else if (path === '/bad') {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"nope"}');
    } else if (path === '/slow') {
      setTimeout(() => res.writeHead(200).end('{}'), 300);
    } else res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('createHttpClient', () => {
  it('parses JSON, applies query and validates with zod', async () => {
    const c = createHttpClient({ name: 'svc', baseUrl: base });
    const r = await c.request({
      path: '/ok',
      query: { a: 1, b: undefined },
      schema: z.object({ n: z.number(), q: z.string() }),
    });
    expect(r.data).toEqual({ n: 1, q: '/ok?a=1' });
  });

  it('retries 5xx for GET and honours Retry-After on 429', async () => {
    const c = createHttpClient({ name: 'svc', baseUrl: base, retries: 3 });
    expect((await c.request<{ n: number }>({ path: '/flaky' })).data.n).toBe(2);
    expect(hits['/flaky']).toBe(3);
    expect((await c.request<{ n: number }>({ path: '/limited' })).data.n).toBe(3);
  });

  it('does not retry POST by default nor 4xx; exposes upstream status/body', async () => {
    const c = createHttpClient({ name: 'svc', baseUrl: base, retries: 3 });
    const err = await c.request({ method: 'POST', path: '/bad', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).upstreamStatus).toBe(400);
    expect((err as UpstreamError).body).toEqual({ error: 'nope' });
    expect(hits['/bad']).toBe(1);
  });

  it('times out and opens the breaker after repeated failures', async () => {
    const c = createHttpClient({ name: 'svc', baseUrl: base, retries: 0, timeoutMs: 50 });
    for (let i = 0; i < 5; i++)
      await expect(c.request({ path: '/slow' })).rejects.toBeInstanceOf(UpstreamError);
    await expect(c.request({ path: '/ok' })).rejects.toThrow(/circuit/);
  });
});
