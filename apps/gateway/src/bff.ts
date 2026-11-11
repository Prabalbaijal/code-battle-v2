import type { AuthHooks } from '@cb/auth';
import {
  historyPageSchema,
  ledgerPageSchema,
  matchHistoryItemSchema,
  pageSchema,
  playerStatsSchema,
  profilePageViewSchema,
  profileViewSchema,
  REQUEST_ID_HEADER,
  type ErrorCode,
  type HistoryPage,
} from '@cb/contracts';
import { AppError } from '@cb/errors';
import type { HttpServer } from '@cb/http-server';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServiceName } from './routes.js';

const matchPageSchema = pageSchema(matchHistoryItemSchema);

/** An upstream answered with an error: keep its status, code and message (e.g. 404 user). */
function upstreamError(status: number, body: unknown): AppError {
  const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
  return new AppError((e?.code ?? 'UPSTREAM_ERROR') as ErrorCode, status, e?.message ?? 'Upstream error');
}

/**
 * Plan §8.1 BFF: the profile page needs user-service (who), rating-service (coins, level) and, on
 * your own profile, battle history joined with the coin ledger (the real delta, v1 bug #21). The
 * browser makes one call; the gateway fans out with the caller's own credentials, so every
 * service still checks the token itself.
 */
export function registerBff(
  app: HttpServer,
  d: { urls: Record<ServiceName, string>; auth: AuthHooks; timeoutMs: number },
): void {
  const get = async <S extends z.ZodType>(
    req: FastifyRequest,
    service: ServiceName,
    path: string,
    schema: S,
  ): Promise<z.infer<S>> => {
    const headers: Record<string, string> = { [REQUEST_ID_HEADER]: req.id };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    let res: Response;
    try {
      res = await fetch(`${d.urls[service]}${path}`, { headers, signal: AbortSignal.timeout(d.timeoutMs) });
    } catch (err) {
      req.log.warn({ err, service, path }, 'bff upstream unreachable');
      throw new AppError('SERVICE_UNAVAILABLE', 503, `${service} unavailable`);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw upstreamError(res.status, body);
    return schema.parse(body);
  };

  /** Optional parts degrade to null instead of failing the whole page. */
  const optional = async <T>(req: FastifyRequest, what: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (err) {
      req.log.warn({ err, what }, 'bff part unavailable');
      return null;
    }
  };

  const history = async (
    req: FastifyRequest,
    cursor: string | undefined,
    limit: number,
  ): Promise<HistoryPage> => {
    const qs = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const page = await get(req, 'battle', `/api/v1/matches/history?${qs}`, matchPageSchema);
    const ids = page.items.map((m) => m.matchId);
    const ledger = ids.length
      ? await optional(
          req,
          'ledger',
          get(req, 'rating', `/api/v1/stats/me/ledger?limit=100&matchIds=${ids.join(',')}`, ledgerPageSchema),
        )
      : { items: [], nextCursor: null };
    const delta = new Map<string, number>();
    for (const e of ledger?.items ?? []) {
      if (e.matchId) delta.set(e.matchId, (delta.get(e.matchId) ?? 0) + e.applied);
    }
    return {
      items: page.items.map((m) => ({
        ...m,
        // no ledger row: the match didn't move coins (aborted) — unless rating couldn't answer
        coinDelta: ledger ? (delta.get(m.matchId) ?? 0) : null,
      })),
      nextCursor: page.nextCursor,
    };
  };

  app.get(
    '/api/v1/bff/profile/:username',
    {
      schema: {
        params: z.object({ username: z.string().min(1).max(40) }),
        response: { 200: profilePageViewSchema },
      },
      preHandler: [d.auth.optionalAuth],
    },
    async (req) => {
      const profile = await get(
        req,
        'user',
        `/api/v1/users/${encodeURIComponent(req.params.username)}`,
        profileViewSchema,
      );
      const isMe = req.auth?.userId === profile.id;
      const [stats, recent] = await Promise.all([
        optional(req, 'stats', get(req, 'rating', `/api/v1/stats/${profile.id}`, playerStatsSchema)),
        isMe ? optional(req, 'history', history(req, undefined, 10)) : Promise.resolve(null),
      ]);
      return { profile, stats, isMe, history: recent };
    },
  );

  app.get(
    '/api/v1/bff/history',
    {
      schema: {
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: historyPageSchema },
      },
      preHandler: [d.auth.authenticate],
    },
    async (req) => history(req, req.query.cursor, req.query.limit),
  );
}
