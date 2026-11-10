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

export type ServiceName = 'identity' | 'user';

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
];

export const serviceUrls = (env: Env): Record<ServiceName, string> => ({
  identity: env.SERVICE_URL_IDENTITY,
  user: env.SERVICE_URL_USER,
});

/** Headers only the gateway may set. Anything a client sends with these names is dropped. */
export const TRUSTED_HEADERS = ['x-user-id', 'x-user-role', 'x-user-verified', 'x-internal-caller'] as const;
