import type { Db } from '@cb/db';
import { AppError, unavailable } from '@cb/errors';
import { and, eq, sql } from 'drizzle-orm';
import { aiBudgetDaily, aiUserUsage } from '../db/schema.js';

const today = sql`(now() at time zone 'utc')::date`;

export interface BudgetLimits {
  tokensPerModel: number;
  requestsPerModel: number;
  userTokens: number;
}

/**
 * Daily spend caps (plan §22.4), in Postgres like the judge's budget: reserve an estimate before a
 * call with a conditional UPDATE (never over the cap, even with many processes), then settle with
 * the real usage. The global cap keeps us under the provider's free tier; the per-player cap keeps
 * one player from using everyone's share.
 */
export class Budget {
  constructor(
    private readonly db: Db,
    private readonly limits: BudgetLimits,
  ) {}

  async reserve(model: string, userId: string | null, tokens: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(aiBudgetDaily).values({ day: today, model }).onConflictDoNothing();
      const ok = await tx
        .update(aiBudgetDaily)
        .set({
          tokensUsed: sql`${aiBudgetDaily.tokensUsed} + ${tokens}`,
          requestsUsed: sql`${aiBudgetDaily.requestsUsed} + 1`,
        })
        .where(
          and(
            eq(aiBudgetDaily.day, today),
            eq(aiBudgetDaily.model, model),
            sql`${aiBudgetDaily.tokensUsed} + ${tokens} <= ${this.limits.tokensPerModel}`,
            sql`${aiBudgetDaily.requestsUsed} + 1 <= ${this.limits.requestsPerModel}`,
          ),
        )
        .returning({ day: aiBudgetDaily.day });
      if (!ok.length) {
        throw unavailable(
          'AI_BUDGET_EXHAUSTED',
          'The AI has used up today’s free allowance. It resets at midnight UTC.',
        );
      }
      if (!userId) return;
      await tx.insert(aiUserUsage).values({ userId, day: today }).onConflictDoNothing();
      const mine = await tx
        .update(aiUserUsage)
        .set({ tokensUsed: sql`${aiUserUsage.tokensUsed} + ${tokens}` })
        .where(
          and(
            eq(aiUserUsage.userId, userId),
            eq(aiUserUsage.day, today),
            sql`${aiUserUsage.tokensUsed} + ${tokens} <= ${this.limits.userTokens}`,
          ),
        )
        .returning({ day: aiUserUsage.day });
      if (!mine.length) {
        // rolls back the global reservation above too
        throw new AppError(
          'AI_QUOTA_EXHAUSTED',
          429,
          'You’ve used your AI allowance for today. It resets at midnight UTC.',
        );
      }
    });
  }

  /** Replace the estimate with what the call really used (never below zero). */
  async settle(model: string, userId: string | null, estimated: number, actual: number): Promise<void> {
    const diff = actual - estimated;
    if (diff === 0) return;
    await this.db
      .update(aiBudgetDaily)
      .set({ tokensUsed: sql`greatest(${aiBudgetDaily.tokensUsed} + ${diff}, 0)` })
      .where(and(eq(aiBudgetDaily.day, today), eq(aiBudgetDaily.model, model)));
    if (userId) {
      await this.db
        .update(aiUserUsage)
        .set({ tokensUsed: sql`greatest(${aiUserUsage.tokensUsed} + ${diff}, 0)` })
        .where(and(eq(aiUserUsage.userId, userId), eq(aiUserUsage.day, today)));
    }
  }

  /** A failed call costs its request but no tokens. */
  refundTokens(model: string, userId: string | null, estimated: number): Promise<void> {
    return this.settle(model, userId, estimated, 0);
  }
}
