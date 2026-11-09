import { roleSchema, type Role } from '@cb/contracts';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Token issuer and audiences (plan §16, §13.1). */
export const ISSUER = 'cb-identity';
export const AUDIENCES = { api: 'cb-api', realtime: 'cb-realtime' } as const;
const ALG = 'EdDSA';

export interface AuthUser {
  userId: string;
  role: Role;
  emailVerified: boolean;
}

const accessClaims = z.object({ sub: z.uuid(), role: roleSchema, ev: z.boolean() });
const ticketClaims = z.object({ sub: z.uuid(), jti: z.string().min(1), exp: z.number() });

/** A private Ed25519 JWK with a `kid` (the format of the `JWT_KEYS` env var). */
export type SigningJwk = JWK & { kid: string; d: string };

/** New Ed25519 key for `scripts/gen-keys.mjs` and the dev/test fallback. */
export async function generateSigningKey(
  kid = `k-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
): Promise<SigningJwk> {
  const { privateKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, kid, alg: ALG, use: 'sig' } as SigningJwk;
}

const publicPart = ({ kty, crv, x, kid }: SigningJwk): JWK => ({ kty, crv, x, kid, alg: ALG, use: 'sig' });

/**
 * Signs access tokens and socket tickets. Only identity-service holds private keys in production;
 * other services use it in tests to mint tokens. The first key signs; all keys are published in the
 * JWKS so tokens signed with a key being rotated out keep verifying until they expire.
 */
export class TokenSigner {
  private constructor(
    private readonly keys: { jwk: SigningJwk; key: Awaited<ReturnType<typeof importJWK>> }[],
  ) {}

  static async create(jwks: SigningJwk[]): Promise<TokenSigner> {
    if (!jwks.length) throw new Error('TokenSigner needs at least one key');
    const kids = new Set(jwks.map((k) => k.kid));
    if (kids.size !== jwks.length) throw new Error('duplicate kid in signing keys');
    return new TokenSigner(
      await Promise.all(jwks.map(async (jwk) => ({ jwk, key: await importJWK(jwk, ALG) }))),
    );
  }

  /** JWKS document served at `/.well-known/jwks.json` (public parts only). */
  publicJwks(): JSONWebKeySet {
    return { keys: this.keys.map((k) => publicPart(k.jwk)) };
  }

  async signAccess(user: AuthUser, ttlSec: number): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const { jwk, key } = this.keys[0]!;
    const token = await new SignJWT({ role: user.role, ev: user.emailVerified })
      .setProtectedHeader({ alg: ALG, kid: jwk.kid, typ: 'at+jwt' })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCES.api)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSec)
      .sign(key);
    return { token, expiresAt: new Date((now + ttlSec) * 1000) };
  }

  /** One-time WebSocket ticket (realtime enforces single use with `jti`). */
  async signTicket(userId: string, ttlSec = 60): Promise<{ ticket: string; jti: string }> {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const { jwk, key } = this.keys[0]!;
    const ticket = await new SignJWT({})
      .setProtectedHeader({ alg: ALG, kid: jwk.kid })
      .setSubject(userId)
      .setJti(jti)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCES.realtime)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSec)
      .sign(key);
    return { ticket, jti };
  }
}

export type VerifyFailure = 'expired' | 'invalid';

export class TokenVerifyError extends Error {
  constructor(readonly reason: VerifyFailure) {
    super(reason === 'expired' ? 'token expired' : 'token invalid');
    this.name = 'TokenVerifyError';
  }
}

export interface JwtVerifierOptions {
  /** Remote JWKS (gateway and services): cached, refetched on unknown `kid` with a cooldown. */
  jwksUrl?: string;
  /** Local key set (identity-service itself and tests). */
  jwks?: JSONWebKeySet;
  /** Allowed clock skew in seconds. */
  clockToleranceSec?: number;
}

/** Verifies access tokens and socket tickets locally against the identity JWKS (no DB call). */
export class JwtVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly tolerance: number;

  constructor(opts: JwtVerifierOptions) {
    if (opts.jwks) this.getKey = createLocalJWKSet(opts.jwks);
    else if (opts.jwksUrl)
      this.getKey = createRemoteJWKSet(new URL(opts.jwksUrl), {
        cacheMaxAge: 10 * 60_000,
        cooldownDuration: 30_000,
        timeoutDuration: 3_000,
      });
    else throw new Error('JwtVerifier needs jwks or jwksUrl');
    this.tolerance = opts.clockToleranceSec ?? 5;
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    const payload = await this.verify(token, AUDIENCES.api);
    const c = accessClaims.safeParse(payload);
    if (!c.success) throw new TokenVerifyError('invalid');
    return { userId: c.data.sub, role: c.data.role, emailVerified: c.data.ev };
  }

  async verifyTicket(ticket: string): Promise<{ userId: string; jti: string; expiresAt: Date }> {
    const payload = await this.verify(ticket, AUDIENCES.realtime);
    const c = ticketClaims.safeParse(payload);
    if (!c.success) throw new TokenVerifyError('invalid');
    return { userId: c.data.sub, jti: c.data.jti, expiresAt: new Date(c.data.exp * 1000) };
  }

  private async verify(token: string, audience: string): Promise<unknown> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: ISSUER,
        audience,
        algorithms: [ALG],
        clockTolerance: this.tolerance,
      });
      return payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenVerifyError('expired');
      // Unknown kid, bad signature, wrong aud/iss, malformed: all "invalid". JWKS fetch failures
      // propagate unchanged so callers can map them to 503 instead of logging the user out.
      if (err instanceof joseErrors.JOSEError && !(err instanceof joseErrors.JWKSTimeout)) {
        throw new TokenVerifyError('invalid');
      }
      throw err;
    }
  }
}

/** Parse `JWT_KEYS` (JSON array of private Ed25519 JWKs with `kid`). */
export function parseSigningKeys(raw: string): SigningJwk[] {
  const schema = z
    .array(
      z
        .object({
          kty: z.literal('OKP'),
          crv: z.literal('Ed25519'),
          x: z.string(),
          d: z.string(),
          kid: z.string().min(1),
        })
        .loose(),
    )
    .min(1);
  return schema.parse(JSON.parse(raw)) as SigningJwk[];
}
