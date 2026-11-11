import type { Role } from '@cb/contracts';
import type { Env } from './config/env.js';

/**
 * What the gateway requires before proxying (plan §16 RBAC; services check again):
 * - public:   no token needed (the service may still read cookies, e.g. /auth/refresh)
 * - optional: a valid token is forwarded as x-user-*; a missing/bad one is just anonymous
 * - user:     a valid access token
 * - verified: a valid token with a verified email (`ev`)
 * - a Role:   at least that role (admin implies problem_setter implies user)
 */
export type Access = 'public' | 'optional' | 'user' | 'verified' | Role;

export type ServiceName = 'identity' | 'user' | 'problem' | 'judge' | 'battle' | 'realtime';

export interface RouteRule {
  prefix: string;
  service: ServiceName;
  access: Access;
}

/**
 * The public API surface. Longest prefix wins; anything not listed is 404 at the gateway.
 * Services keep their own finer-grained checks (e.g. /users/me needs a user, /users/:name doesn't).
 */
export const ROUTES: RouteRule[] = [
  { prefix: '/api/v1/auth', service: 'identity', access: 'public' },
  { prefix: '/api/v1/users', service: 'user', access: 'optional' },
  { prefix: '/api/v1/friends', service: 'user', access: 'user' },
  { prefix: '/api/v1/problems', service: 'problem', access: 'optional' },
  { prefix: '/api/v1/admin/problems', service: 'problem', access: 'problem_setter' },
  { prefix: '/api/v1/admin/judge', service: 'judge', access: 'admin' },
  { prefix: '/api/v1/submissions', service: 'judge', access: 'user' },
  { prefix: '/api/v1/languages', service: 'judge', access: 'public' },
  { prefix: '/api/v1/judge', service: 'judge', access: 'public' },
  // battle-service checks a verified email itself where it matters (challenge, accept)
  { prefix: '/api/v1/challenges', service: 'battle', access: 'user' },
  { prefix: '/api/v1/matches', service: 'battle', access: 'user' },
  // lobby lists and online dots; the socket itself goes straight to realtime (Caddy in production)
  { prefix: '/api/v1/presence', service: 'realtime', access: 'user' },
  // Judge0 callbacks: no user token; each URL carries an HMAC signature checked by judge-service
  { prefix: '/api/v1/hooks/judge0', service: 'judge', access: 'public' },
];

export const serviceUrls = (env: Env): Record<ServiceName, string> => ({
  identity: env.SERVICE_URL_IDENTITY,
  user: env.SERVICE_URL_USER,
  problem: env.SERVICE_URL_PROBLEM,
  judge: env.SERVICE_URL_JUDGE,
  battle: env.SERVICE_URL_BATTLE,
  realtime: env.SERVICE_URL_REALTIME,
});

/** Headers only the gateway may set. Anything a client sends with these names is dropped. */
export const TRUSTED_HEADERS = ['x-user-id', 'x-user-role', 'x-user-verified', 'x-internal-caller'] as const;
