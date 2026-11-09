import { AppError } from '@cb/errors';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInternalAuth, signInternalToken } from './internal.js';
import { generateSigningKey, TokenSigner } from './tokens.js';

const SECRET = 's'.repeat(40);
const req = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as FastifyRequest;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.status : String(e)),
  );

describe('internal service tokens', () => {
  it('accepts a fresh token and records the caller', async () => {
    const hook = createInternalAuth(SECRET);
    const r = req(`Bearer ${await signInternalToken(SECRET, 'gateway')}`);
    expect(await status(hook(r))).toBe('ok');
    expect(r.internalCaller).toBe('gateway');
  });

  it('rejects missing, wrong-secret, expired and user access tokens', async () => {
    const hook = createInternalAuth(SECRET);
    expect(await status(hook(req()))).toBe(401);
    expect(await status(hook(req(`Bearer ${await signInternalToken('x'.repeat(40), 'gateway')}`)))).toBe(401);
    expect(await status(hook(req(`Bearer ${await signInternalToken(SECRET, 'gateway', -30)}`)))).toBe(401);
    const signer = await TokenSigner.create([await generateSigningKey('k')]);
    const access = await signer.signAccess(
      { userId: '0190f0f0-0000-7000-8000-000000000000', role: 'admin', emailVerified: true },
      60,
    );
    expect(await status(hook(req(`Bearer ${access.token}`)))).toBe(401);
  });

  it('refuses short secrets', () => {
    expect(() => createInternalAuth('short')).toThrow(/at least 32/);
  });
});
