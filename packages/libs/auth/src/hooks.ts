import { AUTH_COOKIES, CSRF_HEADER, type Role } from '@cb/contracts';
import { AppError, forbidden, unauthorized, unavailable } from '@cb/errors';
import type { FastifyRequest } from 'fastify';
import { TokenVerifyError, type AuthUser, type JwtVerifier } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate` / `optionalAuth`. The only trusted source of the acting user. */
    auth?: AuthUser;
  }
}

/** Minimal Cookie header parser (no plugin needed just to read a cookie). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Bearer header wins over the cookie (non-browser clients, tests). */
export function extractAccessToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim() || undefined;
  return parseCookies(req.headers.cookie)[AUTH_COOKIES.access];
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Role hierarchy: admin can do everything a problem_setter or user can. */
export const hasRole = (actual: Role, needed: Role): boolean =>
  actual === needed || actual === 'admin' || (needed === 'user' && actual === 'problem_setter');

export interface AuthHooksOptions {
  /** Require `x-cb-csrf: 1` on unsafe requests that carry auth cookies (plan §16). Default true. */
  csrf?: boolean;
}

/**
 * Fastify preHandlers. Usage:
 *   app.post(url, { preHandler: [auth.authenticate, auth.requireVerified] }, handler)
 */
export function createAuthHooks(verifier: JwtVerifier, opts: AuthHooksOptions = {}) {
  const csrf = opts.csrf ?? true;

  /** Cookie-authenticated mutations must carry the CSRF header. Bearer requests can't be forged cross-site. */
  const csrfGuard = async (req: FastifyRequest) => {
    if (!csrf || !UNSAFE.has(req.method)) return;
    if (req.headers.authorization?.startsWith('Bearer ')) return;
    const cookies = parseCookies(req.headers.cookie);
    if (!(AUTH_COOKIES.access in cookies) && !(AUTH_COOKIES.refresh in cookies)) return;
    if (req.headers[CSRF_HEADER] !== '1') throw forbidden(`${CSRF_HEADER} header required`);
  };

  const resolve = async (req: FastifyRequest): Promise<AuthUser | undefined> => {
    const token = extractAccessToken(req);
    if (!token) return undefined;
    try {
      return await verifier.verifyAccess(token);
    } catch (err) {
      if (err instanceof TokenVerifyError) {
        throw new AppError(
          'UNAUTHORIZED',
          401,
          err.reason === 'expired' ? 'Access token expired' : 'Invalid access token',
          {
            details: { reason: err.reason },
          },
        );
      }
      req.log.error({ err }, 'access token verification unavailable');
      throw unavailable('SERVICE_UNAVAILABLE', 'Authentication temporarily unavailable');
    }
  };

  const authenticate = async (req: FastifyRequest) => {
    await csrfGuard(req);
    const user = await resolve(req);
    if (!user) throw unauthorized();
    req.auth = user;
  };

  const optionalAuth = async (req: FastifyRequest) => {
    await csrfGuard(req);
    const user = await resolve(req).catch(() => undefined);
    if (user) req.auth = user;
  };

  const requireRole =
    (role: Role) =>
    async (req: FastifyRequest): Promise<void> => {
      if (!req.auth) throw unauthorized();
      if (!hasRole(req.auth.role, role)) throw forbidden();
    };

  /** Playing requires a verified email (`ev` claim, plan §11.7). */
  const requireVerified = async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (!req.auth.emailVerified) throw new AppError('EMAIL_NOT_VERIFIED', 403, 'Verify your email first');
  };

  return { authenticate, optionalAuth, requireRole, requireVerified, csrfGuard };
}

export type AuthHooks = ReturnType<typeof createAuthHooks>;

/** The acting user, set by `authenticate`. Throws if a route forgot the hook. */
export function authUser(req: FastifyRequest): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
