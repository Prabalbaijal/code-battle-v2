import { AppError } from '@cb/errors';
import type { FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthHooks, hasRole, parseCookies } from './hooks.js';
import {
  AUDIENCES,
  generateSigningKey,
  ISSUER,
  JwtVerifier,
  parseSigningKeys,
  TokenSigner,
  TokenVerifyError,
  type SigningJwk,
} from './tokens.js';

const user = { userId: randomUUID(), role: 'user' as const, emailVerified: true };
let k1: SigningJwk;
let k2: SigningJwk;
let signer: TokenSigner;
let verifier: JwtVerifier;

beforeAll(async () => {
  [k1, k2] = await Promise.all([generateSigningKey('k1'), generateSigningKey('k2')]);
  signer = await TokenSigner.create([k1]);
  verifier = new JwtVerifier({ jwks: signer.publicJwks() });
});

const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof TokenVerifyError ? e.reason : String(e)),
  );

describe('tokens', () => {
  it('signs and verifies an access token; JWKS exposes only public parts', async () => {
    const { token, expiresAt } = await signer.signAccess(user, 900);
    expect(await verifier.verifyAccess(token)).toEqual(user);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 890_000);
    const jwks = signer.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty('d');
    expect(jwks.keys[0]).toMatchObject({ kid: 'k1', kty: 'OKP', crv: 'Ed25519' });
  });

  it('rejects expired, tampered, foreign-key and wrong-audience tokens', async () => {
    const expired = await signer.signAccess(user, -60);
    expect(await reason(verifier.verifyAccess(expired.token))).toBe('expired');

    const { token } = await signer.signAccess(user, 900);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'admin' }),
    ).toString('base64url');
    expect(await reason(verifier.verifyAccess(`${h}.${forged}.${s}`))).toBe('invalid');

    const other = await TokenSigner.create([k2]);
    expect(await reason(verifier.verifyAccess((await other.signAccess(user, 900)).token))).toBe('invalid');

    const { ticket } = await signer.signTicket(user.userId);
    expect(await reason(verifier.verifyAccess(ticket))).toBe('invalid');
    expect(await reason(verifier.verifyAccess('not-a-jwt'))).toBe('invalid');
  });

  it('rejects HS256 / alg confusion and missing claims', async () => {
    const hs = await new SignJWT({ role: 'admin', ev: true })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCES.api)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect(await reason(verifier.verifyAccess(hs))).toBe('invalid');
  });

  it('supports key rotation: new key signs, old tokens still verify', async () => {
    const old = await signer.signAccess(user, 900);
    const rotated = await TokenSigner.create([k2, k1]);
    const v = new JwtVerifier({ jwks: rotated.publicJwks() });
    expect(await v.verifyAccess(old.token)).toEqual(user);
    const fresh = await rotated.signAccess(user, 900);
    expect(JSON.parse(Buffer.from(fresh.token.split('.')[0]!, 'base64url').toString()).kid).toBe('k2');
    expect(await v.verifyAccess(fresh.token)).toEqual(user);
  });

  it('issues single-purpose socket tickets', async () => {
    const { ticket, jti } = await signer.signTicket(user.userId, 60);
    const t = await verifier.verifyTicket(ticket);
    expect(t).toMatchObject({ userId: user.userId, jti });
    const { token } = await signer.signAccess(user, 900);
    expect(await reason(verifier.verifyTicket(token))).toBe('invalid');
  });

  it('parses JWT_KEYS and rejects bad input', () => {
    expect(parseSigningKeys(JSON.stringify([k1, k2])).map((k) => k.kid)).toEqual(['k1', 'k2']);
    expect(() => parseSigningKeys('[]')).toThrow();
    expect(() => parseSigningKeys(JSON.stringify([{ ...k1, d: undefined }]))).toThrow();
  });
});

describe('hooks', () => {
  const req = (headers: Record<string, string>, method = 'GET') =>
    ({ headers, method, log: { error() {} } }) as unknown as FastifyRequest;
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof AppError ? `${e.status} ${e.code}` : String(e)),
    );

  it('parses cookies', () => {
    expect(parseCookies('a=1; cb_at=x%20y; b="q"; =bad; a=2')).toEqual({ a: '1', cb_at: 'x y', b: 'q' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('role hierarchy', () => {
    expect(hasRole('admin', 'problem_setter')).toBe(true);
    expect(hasRole('problem_setter', 'user')).toBe(true);
    expect(hasRole('user', 'problem_setter')).toBe(false);
    expect(hasRole('problem_setter', 'admin')).toBe(false);
  });

  it('authenticates via cookie or bearer; enforces CSRF only for cookie mutations', async () => {
    const auth = createAuthHooks(verifier);
    const { token } = await signer.signAccess(user, 900);

    const r1 = req({ cookie: `cb_at=${token}` });
    expect(await code(auth.authenticate(r1))).toBe('ok');
    expect(r1.auth).toEqual(user);

    expect(await code(auth.authenticate(req({ cookie: `cb_at=${token}` }, 'POST')))).toBe('403 FORBIDDEN');
    expect(await code(auth.authenticate(req({ cookie: `cb_at=${token}`, 'x-cb-csrf': '1' }, 'POST')))).toBe(
      'ok',
    );
    expect(await code(auth.authenticate(req({ authorization: `Bearer ${token}` }, 'POST')))).toBe('ok');

    expect(await code(auth.authenticate(req({})))).toBe('401 UNAUTHORIZED');
    const expired = await signer.signAccess(user, -60);
    expect(await code(auth.authenticate(req({ authorization: `Bearer ${expired.token}` })))).toBe(
      '401 UNAUTHORIZED',
    );

    const anon = req({});
    expect(await code(auth.optionalAuth(anon))).toBe('ok');
    expect(anon.auth).toBeUndefined();
  });

  it('requireRole and requireVerified', async () => {
    const auth = createAuthHooks(verifier);
    const r = req({});
    r.auth = { ...user, emailVerified: false };
    expect(await code(auth.requireVerified(r))).toBe('403 EMAIL_NOT_VERIFIED');
    expect(await code(auth.requireRole('admin')(r))).toBe('403 FORBIDDEN');
    r.auth = { ...user, role: 'admin' };
    expect(await code(auth.requireRole('problem_setter')(r))).toBe('ok');
  });
});
