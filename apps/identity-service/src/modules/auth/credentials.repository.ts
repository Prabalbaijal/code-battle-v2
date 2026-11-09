import type { Executor } from '@cb/db';
import { eq, sql } from 'drizzle-orm';
import { credentials, type Credential } from '../../db/schema.js';

export type NewCredential = Pick<Credential, 'userId' | 'email' | 'username' | 'fullname' | 'passwordHash'>;

/** After this many consecutive failures the account is locked for LOCK_MINUTES (plan §16). */
export const MAX_FAILED_LOGINS = 10;
export const LOCK_MINUTES = 15;

/** SQL only. Every method takes the executor (db or tx) chosen by the service. */
export const credentialsRepository = {
  async insert(ex: Executor, row: NewCredential): Promise<Credential> {
    const [c] = await ex.insert(credentials).values(row).returning();
    return c!;
  },

  async findById(ex: Executor, userId: string): Promise<Credential | undefined> {
    const [c] = await ex.select().from(credentials).where(eq(credentials.userId, userId));
    return c;
  },

  /** citext columns compare case-insensitively. */
  async findByLogin(ex: Executor, identifier: string): Promise<Credential | undefined> {
    const col = identifier.includes('@') ? credentials.email : credentials.username;
    const [c] = await ex.select().from(credentials).where(eq(col, identifier));
    return c;
  },

  async findByIdForUpdate(ex: Executor, userId: string): Promise<Credential | undefined> {
    const [c] = await ex.select().from(credentials).where(eq(credentials.userId, userId)).for('update');
    return c;
  },

  /**
   * Atomic failure counter: concurrent wrong attempts can't lose increments. On reaching the
   * threshold the account locks and the counter resets. Returns the lock time if it just locked.
   */
  async recordFailedLogin(ex: Executor, userId: string): Promise<Date | null> {
    const [r] = await ex
      .update(credentials)
      .set({
        failedLoginCount: sql`case when ${credentials.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then 0 else ${credentials.failedLoginCount} + 1 end`,
        lockedUntil: sql`case when ${credentials.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${credentials.lockedUntil} end`,
        updatedAt: sql`now()`,
      })
      .where(eq(credentials.userId, userId))
      .returning({ lockedUntil: credentials.lockedUntil, count: credentials.failedLoginCount });
    return r && r.count === 0 && r.lockedUntil ? r.lockedUntil : null;
  },

  async recordSuccessfulLogin(ex: Executor, userId: string, rehash?: string): Promise<void> {
    await ex
      .update(credentials)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: sql`now()`,
        ...(rehash ? { passwordHash: rehash, passwordAlgo: 'argon2id' as const } : {}),
      })
      .where(eq(credentials.userId, userId));
  },

  /** Sets verified once; returns the timestamp only if this call verified the email. */
  async markEmailVerified(ex: Executor, userId: string): Promise<Date | null> {
    const [r] = await ex
      .update(credentials)
      .set({ emailVerifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(sql`${credentials.userId} = ${userId} and ${credentials.emailVerifiedAt} is null`)
      .returning({ at: credentials.emailVerifiedAt });
    return r?.at ?? null;
  },

  async setPassword(ex: Executor, userId: string, passwordHash: string): Promise<void> {
    await ex
      .update(credentials)
      .set({
        passwordHash,
        passwordAlgo: 'argon2id',
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(eq(credentials.userId, userId));
  },
};
