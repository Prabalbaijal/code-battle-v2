import { describe, expect, it } from 'vitest';
import { proxyToGateway } from './proxy';

interface Seen {
  url: string;
  init: RequestInit;
}

function gateway(respond: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond();
  }) as typeof fetch;
  return { seen, cfg: { gatewayUrl: 'http://gateway:8080/', timeoutMs: 1000, fetchImpl } };
}

describe('proxyToGateway', () => {
  it('forwards method, path, query, headers and body to the gateway', async () => {
    const { seen, cfg } = gateway(() => Response.json({ ok: true }, { status: 201 }));
    const req = new Request('http://localhost:3000/api/v1/friends/requests?x=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'cb_at=t',
        'x-cb-csrf': '1',
        connection: 'keep-alive',
      },
      body: JSON.stringify({ toUserId: 'u' }),
    });
    const res = await proxyToGateway(req, ['v1', 'friends', 'requests'], cfg);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen[0]!.url).toBe('http://gateway:8080/api/v1/friends/requests?x=1');
    const h = seen[0]!.init.headers as Headers;
    expect([h.get('cookie'), h.get('x-cb-csrf'), h.get('connection')]).toEqual(['cb_at=t', '1', null]);
    expect(new TextDecoder().decode(seen[0]!.init.body as ArrayBuffer)).toBe('{"toUserId":"u"}');
  });

  it('keeps every Set-Cookie separate and drops encoding headers', async () => {
    const { cfg } = gateway(() => {
      const h = new Headers({
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-request-id': 'r1',
      });
      h.append('set-cookie', 'cb_at=a; Path=/; HttpOnly');
      h.append('set-cookie', 'cb_rt=b; Path=/api/v1/auth; HttpOnly');
      return new Response('{}', { status: 200, headers: h });
    });
    const res = await proxyToGateway(
      new Request('http://localhost:3000/api/v1/auth/login', { method: 'POST' }),
      ['v1', 'auth', 'login'],
      cfg,
    );
    expect(res.headers.getSetCookie()).toEqual([
      'cb_at=a; Path=/; HttpOnly',
      'cb_rt=b; Path=/api/v1/auth; HttpOnly',
    ]);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-request-id')).toBe('r1');
  });

  it('passes 204 through without a body', async () => {
    const { cfg } = gateway(() => new Response(null, { status: 204 }));
    const res = await proxyToGateway(
      new Request('http://localhost:3000/api/v1/friends/x', { method: 'DELETE' }),
      ['v1', 'friends', 'x'],
      cfg,
    );
    expect([res.status, await res.text()]).toEqual([204, '']);
  });

  it('maps an unreachable gateway to 502 and a slow one to 504, in the API error format', async () => {
    const down = await proxyToGateway(new Request('http://localhost:3000/api/v1/x'), ['v1', 'x'], {
      gatewayUrl: 'http://gateway:8080',
      timeoutMs: 1000,
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    });
    expect([down.status, (await down.json()).error.code]).toEqual([502, 'SERVICE_UNAVAILABLE']);

    const slow = await proxyToGateway(new Request('http://localhost:3000/api/v1/x'), ['v1', 'x'], {
      gatewayUrl: 'http://gateway:8080',
      timeoutMs: 1000,
      fetchImpl: (() =>
        Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as typeof fetch,
    });
    expect([slow.status, (await slow.json()).error.code]).toEqual([504, 'UPSTREAM_ERROR']);
  });

  it('encodes path segments (no traversal into other gateway paths)', async () => {
    const { seen, cfg } = gateway(() => Response.json({}));
    await proxyToGateway(
      new Request('http://localhost:3000/api/v1/users/x'),
      ['v1', 'users', '../../internal'],
      cfg,
    );
    expect(seen[0]!.url).toBe('http://gateway:8080/api/v1/users/..%2F..%2Finternal');
  });
});
