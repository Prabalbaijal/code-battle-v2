import type { Executor } from '@cb/db';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { profiles, type ProfileRow } from '../../db/schema.js';

/** Escape LIKE wildcards so `q` is matched literally. */
const likePrefix = (q: string) => `${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const lowerName = sql<string>`lower(${profiles.username}::text)`;

/** SQL only. */
export const profileRepository = {
  /** Idempotent replica insert from the registration event. */
  async insertFromRegistration(
    ex: Executor,
    row: { userId: string; username: string; fullname: string; createdAt: Date },
  ): Promise<boolean> {
    const r = await ex
      .insert(profiles)
      .values({ ...row, updatedAt: row.createdAt })
      .onConflictDoNothing()
      .returning({ id: profiles.userId });
    return r.length > 0;
  },

  async findById(ex: Executor, userId: string): Promise<ProfileRow | undefined> {
    const [p] = await ex.select().from(profiles).where(eq(profiles.userId, userId));
    return p;
  },

  async findByUsername(ex: Executor, username: string): Promise<ProfileRow | undefined> {
    const [p] = await ex.select().from(profiles).where(eq(profiles.username, username));
    return p;
  },

  async findManyByIds(ex: Executor, ids: string[]): Promise<ProfileRow[]> {
    if (!ids.length) return [];
    return ex.select().from(profiles).where(inArray(profiles.userId, ids));
  },

  async update(
    ex: Executor,
    userId: string,
    patch: Partial<Pick<ProfileRow, 'fullname' | 'bio' | 'avatarUrl'>>,
  ): Promise<ProfileRow | undefined> {
    const [p] = await ex
      .update(profiles)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(profiles.userId, userId))
      .returning();
    return p;
  },

  /** Prefix search on lower(username) (text_pattern_ops index), keyset-paginated by that key. */
  async searchPrefix(
    ex: Executor,
    q: string,
    after: string | undefined,
    limit: number,
  ): Promise<ProfileRow[]> {
    return ex
      .select()
      .from(profiles)
      .where(
        after
          ? sql`${lowerName} like ${likePrefix(q)} and ${lowerName} > ${after}`
          : sql`${lowerName} like ${likePrefix(q)}`,
      )
      .orderBy(asc(lowerName))
      .limit(limit);
  },

  /** Typo-tolerant fallback (pg_trgm `%`, GIN index). Not paginated. */
  async searchFuzzy(ex: Executor, q: string, limit: number): Promise<ProfileRow[]> {
    return ex
      .select()
      .from(profiles)
      .where(sql`${profiles.username} % ${q}`)
      .orderBy(desc(sql`similarity(${profiles.username}, ${q})`), asc(lowerName))
      .limit(limit);
  },
};
