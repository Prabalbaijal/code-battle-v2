import { unauthorized } from '@cb/errors';
import type { FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Service-to-service auth for `/internal/*` routes (plan §7.3): a short-lived HS256 JWT signed with
 * the shared INTERNAL_SERVICE_SECRET, `aud=cb-internal`, `sub=<calling service>`. The gateway never
 * routes `/internal/*`, so this is a second line of defence, not the only one.
 */
export const INTERNAL_AUDIENCE = 'cb-internal';
const ALG = 'HS256';
export const MIN_INTERNAL_SECRET_LENGTH = 32;

declare module 'fastify' {
  interface FastifyRequest {
    /** Calling service name, set by the internal auth hook. */
    internalCaller?: string;
  }
}

const keyOf = (secret: string) => {
  if (secret.length < MIN_INTERNAL_SECRET_LENGTH) {
    throw new Error(`internal service secret must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(secret);
};

/** Mint a token for one outgoing call (or cache it for < ttl). */
export async function signInternalToken(secret: string, service: string, ttlSec = 60): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(service)
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(keyOf(secret));
}

/** Fastify preHandler for `/internal/*` routes. */
export function createInternalAuth(secret: string) {
  const key = keyOf(secret);
  return async (req: FastifyRequest): Promise<void> => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized('Service token required');
    try {
      const { payload } = await jwtVerify(h.slice(7), key, {
        audience: INTERNAL_AUDIENCE,
        algorithms: [ALG],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no sub');
      req.internalCaller = payload.sub;
    } catch {
      throw unauthorized('Invalid service token');
    }
  };
}
