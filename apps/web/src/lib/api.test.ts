import { beforeEach, describe, expect, it } from 'vitest';
import { api, ApiError, refreshSession, setFetch } from './api';
import { safeNext } from './session';

interface Call {
  url: string;
  init: RequestInit;
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const err = (status: number, code: string, message = code) => json(status, { error: { code, message } });

/** Scripted transport: the handler sees every call and decides the response. */
function transport(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  setFetch(async (input, init) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    return handler(c, calls.length);
  });
  return calls;
}

const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('api client', () => {
  beforeEach(() => transport(() => json(200, {})));

  it('sends same-origin JSON with the CSRF header on mutations only', async () => {
    const calls = transport(() => json(200, { ok: true }));
    await api('/users/me');
    await api('/friends/requests', { method: 'POST', body: { toUserId: 'x' } });
    expect(calls[0]!.url).toBe('/api/v1/users/me');
    expect(headerOf(calls[0]!, 'x-cb-csrf')).toBeUndefined();
    expect(calls[1]!.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: '{"toUserId":"x"}',
    });
    expect(headerOf(calls[1]!, 'x-cb-csrf')).toBe('1');
  });

  it('refreshes once on 401 and retries with the same idempotency key', async () => {
    let refreshed = false;
    const calls = transport((c) => {
      if (c.url.endsWith('/auth/refresh')) {
        refreshed = true;
        return json(200, {});
      }
      return refreshed ? json(200, { status: 'pending' }) : err(401, 'UNAUTHORIZED');
    });
    const r = await api('/friends/requests', { method: 'POST', body: {}, idempotent: true });
    expect(r).toEqual({ status: 'pending' });
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/friends/requests',
      '/api/v1/auth/refresh',
      '/api/v1/friends/requests',
    ]);
    expect(headerOf(calls[0]!, 'idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headerOf(calls[2]!, 'idempotency-key')).toBe(headerOf(calls[0]!, 'idempotency-key'));
  });

  it('EMAIL_NOT_VERIFIED: refreshes once (the token may predate verification) and retries with a new key', async () => {
    let refreshed = false;
    const calls = transport((c) => {
      if (c.url.endsWith('/auth/refresh')) {
        refreshed = true;
        return json(200, {});
      }
      return refreshed ? json(200, { status: 'pending' }) : err(403, 'EMAIL_NOT_VERIFIED');
    });
    const r = await api('/friends/requests', { method: 'POST', body: {}, idempotent: true });
    expect(r).toEqual({ status: 'pending' });
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/friends/requests',
      '/api/v1/auth/refresh',
      '/api/v1/friends/requests',
    ]);
    expect(headerOf(calls[2]!, 'idempotency-key')).not.toBe(headerOf(calls[0]!, 'idempotency-key'));
  });

  it('still not verified after the refresh: the 403 reaches the caller', async () => {
    transport((c) => (c.url.endsWith('/auth/refresh') ? json(200, {}) : err(403, 'EMAIL_NOT_VERIFIED')));
    await expect(api('/friends/requests', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('single flight: concurrent 401s share one refresh', async () => {
    let refreshes = 0;
    let refreshed = false;
    transport(async (c) => {
      if (c.url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        refreshed = true;
        return json(200, {});
      }
      return refreshed ? json(200, { ok: 1 }) : err(401, 'UNAUTHORIZED');
    });
    await Promise.all([api('/a'), api('/b'), api('/c'), api('/d')]);
    expect(refreshes).toBe(1);
    // and a later expiry can refresh again
    refreshed = false;
    await api('/e');
    expect(refreshes).toBe(2);
  });

  it('a 409 from refresh (another tab rotated) still retries', async () => {
    let n = 0;
    transport((c) => {
      if (c.url.endsWith('/auth/refresh')) return err(409, 'CONFLICT');
      return ++n === 1 ? err(401, 'UNAUTHORIZED') : json(200, { ok: true });
    });
    await expect(api('/x')).resolves.toEqual({ ok: true });
  });

  it('gives up when the refresh fails, and never refreshes for auth endpoints', async () => {
    const calls = transport((c) =>
      c.url.endsWith('/auth/refresh') ? err(401, 'TOKEN_INVALID') : err(401, 'UNAUTHORIZED'),
    );
    await expect(api('/friends')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/friends', '/api/v1/auth/refresh']); // no retry after a failed refresh

    const loginCalls = transport(() => err(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password'));
    const e = await api('/auth/login', { method: 'POST', body: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('INVALID_CREDENTIALS');
    expect(loginCalls).toHaveLength(1);
  });

  it('maps errors: API error body, unknown body, network failure, 204', async () => {
    transport(() =>
      json(409, { error: { code: 'USERNAME_TAKEN', message: 'Username is taken', details: { a: 1 } } }),
    );
    await expect(api('/auth/register', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'USERNAME_TAKEN',
      message: 'Username is taken',
      details: { a: 1 },
    });
    transport(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
    setFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    transport(() => new Response(null, { status: 204 }));
    await expect(api('/friends/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('refreshSession reports network failure as false', async () => {
    setFetch(() => Promise.reject(new TypeError('offline')));
    expect(await refreshSession()).toBe(false);
  });
});

describe('safeNext', () => {
  it('allows same-site paths only', () => {
    expect(safeNext('/u/alice?x=1')).toBe('/u/alice?x=1');
    for (const bad of [null, '', 'https://evil.com', '//evil.com', '/\\evil.com', 'friends']) {
      expect(safeNext(bad)).toBe('/friends');
    }
  });
});
