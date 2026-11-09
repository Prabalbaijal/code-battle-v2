import type { Executor } from '@cb/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { emailLog, type EmailLog } from '../../db/schema.js';

/** A `sending` row older than this is assumed abandoned (worker crashed mid-send) and can be retaken. */
export const STALE_SENDING_SEC = 300;

/** SQL only. */
export const emailRepository = {
  /**
   * Claim the right to send `dedupeKey`. Returns the row if this caller may send now, otherwise
   * undefined (already sent, permanently failed, or another worker is sending right now).
   */
  async claim(
    ex: Executor,
    row: { dedupeKey: string; template: string; toHash: string; provider: string },
  ): Promise<EmailLog | undefined> {
    const [r] = await ex
      .insert(emailLog)
      .values({ ...row, status: 'sending', attempts: 1 })
      .onConflictDoUpdate({
        target: emailLog.dedupeKey,
        set: {
          status: 'sending',
          attempts: sql`${emailLog.attempts} + 1`,
          updatedAt: sql`now()`,
          provider: row.provider,
        },
        setWhere: sql`${emailLog.status} = 'pending' or (${emailLog.status} = 'sending' and ${emailLog.updatedAt} < now() - make_interval(secs => ${STALE_SENDING_SEC}))`,
      })
      .returning();
    return r;
  },

  async find(ex: Executor, dedupeKey: string): Promise<EmailLog | undefined> {
    const [r] = await ex.select().from(emailLog).where(eq(emailLog.dedupeKey, dedupeKey));
    return r;
  },

  async markSent(ex: Executor, dedupeKey: string, providerMessageId: string): Promise<void> {
    await ex
      .update(emailLog)
      .set({ status: 'sent', providerMessageId, sentAt: sql`now()`, updatedAt: sql`now()`, lastError: null })
      .where(eq(emailLog.dedupeKey, dedupeKey));
  },

  /** Retryable failure: release the claim so the next attempt can take it. */
  async release(ex: Executor, dedupeKey: string, error: string): Promise<void> {
    await ex
      .update(emailLog)
      .set({ status: 'pending', lastError: error.slice(0, 1000), updatedAt: sql`now()` })
      .where(and(eq(emailLog.dedupeKey, dedupeKey), eq(emailLog.status, 'sending')));
  },

  async markFailed(ex: Executor, dedupeKey: string, error: string): Promise<void> {
    await ex
      .update(emailLog)
      .set({ status: 'failed', lastError: error.slice(0, 1000), updatedAt: sql`now()` })
      .where(sql`${emailLog.dedupeKey} = ${dedupeKey} and ${emailLog.status} <> 'sent'`);
  },

  /** Emails sent since midnight UTC (daily provider quota). */
  async sentToday(ex: Executor): Promise<number> {
    const [r] = await ex
      .select({ n: sql<number>`count(*)::int` })
      .from(emailLog)
      .where(gte(emailLog.sentAt, sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`));
    return r?.n ?? 0;
  },
};
