import { IDEMPOTENCY_HEADER } from '@cb/contracts';
import type { Db } from '@cb/db';
import { AppError, badRequest } from '@cb/errors';
import { and, eq } from 'drizzle-orm';
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

/** Stored HTTP responses keyed by (user, Idempotency-Key). Plan §12. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'done'] }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON.stringify with sorted keys, so `{a,b}` and `{b,a}` hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export interface IdempotencyOptions {
  db: Db;
  /** Who owns the key. Authenticated routes: the user id. Public routes: e.g. `ip:<addr>`. */
  getOwner: (req: FastifyRequest) => string;
  /** Reject requests without the header (400 IDEMPOTENCY_KEY_REQUIRED). Default true. */
  required?: boolean;
  ttlHours?: number;
}

interface Ctx {
  owner: string;
  key: string;
}

/**
 * Route hooks implementing Idempotency-Key semantics:
 *  - first request: row `in_progress` → handler runs → response stored (`done`)
 *  - replay with same body: stored response returned (header `idempotent-replayed: true`)
 *  - same key, different body: 422 IDEMPOTENCY_KEY_REUSED
 *  - concurrent duplicate while in progress: 409 REQUEST_IN_PROGRESS
 *  - 5xx responses are not stored (row deleted) so the client can retry.
 * Usage: `app.post(url, { preHandler: idem.preHandler, onSend: idem.onSend }, handler)`.
 */
export function createIdempotency(opts: IdempotencyOptions) {
  const ctxs = new WeakMap<FastifyRequest, Ctx>();
  const ttlMs = (opts.ttlHours ?? 24) * 3600_000;

  const preHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      if (opts.required ?? true) {
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, `${IDEMPOTENCY_HEADER} header is required`);
      }
      return;
    }
    if (!UUID_RE.test(key)) throw badRequest(`${IDEMPOTENCY_HEADER} must be a UUID`);

    const owner = opts.getOwner(req);
    const route = `${req.method} ${req.routeOptions.url ?? req.url}`;
    const requestHash = createHash('sha256')
      .update(`${route}\n${stableStringify(req.body ?? null)}`)
      .digest('hex');

    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await opts.db
        .insert(idempotencyKeys)
        .values({
          userId: owner,
          key,
          route,
          requestHash,
          status: 'in_progress',
          expiresAt: new Date(Date.now() + ttlMs),
        })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (inserted.length) {
        ctxs.set(req, { owner, key });
        return;
      }
      const [row] = await opts.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, owner), eq(idempotencyKeys.key, key)));
      if (!row) continue; // deleted concurrently (5xx) — try to claim again
      if (row.expiresAt.getTime() < Date.now()) {
        await opts.db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.userId, owner), eq(idempotencyKeys.key, key)));
        continue;
      }
      if (row.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          422,
          'Idempotency-Key was used with a different request',
        );
      }
      if (row.status === 'in_progress') {
        throw new AppError('REQUEST_IN_PROGRESS', 409, 'A request with this Idempotency-Key is in progress');
      }
      reply.header('idempotent-replayed', 'true');
      return reply.code(row.responseStatus ?? 200).send(row.responseBody);
    }
    throw new AppError('CONFLICT', 409, 'Could not claim Idempotency-Key, retry');
  };

  const onSend = async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const ctx = ctxs.get(req);
    if (!ctx) return payload;
    ctxs.delete(req);
    const where = and(eq(idempotencyKeys.userId, ctx.owner), eq(idempotencyKeys.key, ctx.key));
    if (reply.statusCode >= 500) {
      await opts.db.delete(idempotencyKeys).where(where);
      return payload;
    }
    let body: unknown = null;
    if (typeof payload === 'string' && payload.length) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    await opts.db
      .update(idempotencyKeys)
      .set({ status: 'done', responseStatus: reply.statusCode, responseBody: body })
      .where(where);
    return payload;
  };

  return { preHandler, onSend };
}
