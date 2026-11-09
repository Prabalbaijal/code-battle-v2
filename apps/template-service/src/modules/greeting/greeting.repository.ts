import type { Executor } from '@cb/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { greetings, type Greeting } from '../../db/schema.js';

/** SQL only. Every method takes the executor (db or tx) chosen by the service. */
export const greetingRepository = {
  async insert(ex: Executor, row: { id: string; authorId: string; message: string }): Promise<Greeting> {
    const [g] = await ex.insert(greetings).values(row).returning();
    return g!;
  },

  async findById(ex: Executor, id: string): Promise<Greeting | undefined> {
    const [g] = await ex.select().from(greetings).where(eq(greetings.id, id));
    return g;
  },

  /** `ack_count` makes duplicate processing visible in tests (it must stay 1). */
  async markAcknowledged(ex: Executor, id: string): Promise<void> {
    await ex
      .update(greetings)
      .set({
        acknowledgedAt: sql`coalesce(${greetings.acknowledgedAt}, now())`,
        ackCount: sql`${greetings.ackCount} + 1`,
      })
      .where(eq(greetings.id, id));
  },

  /** Compare-and-set: only the first run of the job has an effect. */
  async markJobProcessed(ex: Executor, id: string): Promise<boolean> {
    const rows = await ex
      .update(greetings)
      .set({ jobProcessedAt: new Date() })
      .where(and(eq(greetings.id, id), isNull(greetings.jobProcessedAt)))
      .returning({ id: greetings.id });
    return rows.length > 0;
  },
};
