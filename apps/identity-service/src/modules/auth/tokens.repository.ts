import type { Executor } from '@cb/db';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { oneTimeTokens, refreshTokens, type RefreshToken, type TokenPurpose } from '../../db/schema.js';

export interface NewRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}

/** SQL for refresh tokens and one-time tokens. */
export const tokensRepository = {
  async insertRefresh(ex: Executor, row: NewRefreshToken): Promise<void> {
    await ex.insert(refreshTokens).values(row);
  },

  /** Row lock serialises concurrent refreshes of the same token. */
  async findRefreshForUpdate(ex: Executor, tokenHash: Buffer): Promise<RefreshToken | undefined> {
    const [t] = await ex
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update');
    return t;
  },

  async findRefresh(ex: Executor, tokenHash: Buffer): Promise<RefreshToken | undefined> {
    const [t] = await ex.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    return t;
  },

  async markRotated(ex: Executor, id: string, replacedBy: string): Promise<void> {
    await ex
      .update(refreshTokens)
      .set({ revokedAt: sql`now()`, replacedBy })
      .where(eq(refreshTokens.id, id));
  },

  async revokeFamily(ex: Executor, familyId: string): Promise<number> {
    const r = await ex
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return r.length;
  },

  async revokeAllForUser(ex: Executor, userId: string): Promise<number> {
    const r = await ex
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return r.length;
  },

  async insertOneTime(
    ex: Executor,
    row: { tokenHash: Buffer; userId: string; purpose: TokenPurpose; expiresAt: Date },
  ): Promise<void> {
    await ex.insert(oneTimeTokens).values(row);
  },

  /** Atomic consume (plan §9.1): only one caller can ever get the user id back. */
  async consumeOneTime(ex: Executor, tokenHash: Buffer, purpose: TokenPurpose): Promise<string | undefined> {
    const [r] = await ex
      .update(oneTimeTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oneTimeTokens.tokenHash, tokenHash),
          eq(oneTimeTokens.purpose, purpose),
          isNull(oneTimeTokens.usedAt),
          gt(oneTimeTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: oneTimeTokens.userId });
    return r?.userId;
  },

  /** Invalidate every other outstanding token of this purpose (e.g. after a password reset). */
  async invalidateOneTime(ex: Executor, userId: string, purpose: TokenPurpose): Promise<void> {
    await ex
      .update(oneTimeTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oneTimeTokens.userId, userId),
          eq(oneTimeTokens.purpose, purpose),
          isNull(oneTimeTokens.usedAt),
        ),
      );
  },

  /** Housekeeping (leader-elected in the worker). */
  async purgeExpired(ex: Executor): Promise<{ refresh: number; oneTime: number }> {
    const refresh = await ex
      .delete(refreshTokens)
      .where(
        or(
          lt(refreshTokens.expiresAt, sql`now() - interval '1 day'`),
          lt(refreshTokens.revokedAt, sql`now() - interval '7 days'`),
        ),
      )
      .returning({ id: refreshTokens.id });
    const oneTime = await ex
      .delete(oneTimeTokens)
      .where(lt(oneTimeTokens.expiresAt, sql`now() - interval '1 day'`))
      .returning({ h: oneTimeTokens.tokenHash });
    return { refresh: refresh.length, oneTime: oneTime.length };
  },
};
