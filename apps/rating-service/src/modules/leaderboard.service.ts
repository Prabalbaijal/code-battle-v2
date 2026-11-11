import type { Leaderboard, LeaderboardEntry, MyRank, Player } from '@cb/contracts';
import type { Db } from '@cb/db';
import type { Logger } from '@cb/logger';
import type { SafeRedis } from '@cb/redis';
import { leaderboardScore } from '@cb/scoring';
import { and, asc, count, desc, eq, gt, gte, lt, not, or, sql } from 'drizzle-orm';
import type { UserDirectory } from '../clients.js';
import { playerStats, type PlayerStatsRow } from '../db/schema.js';
import type { StatsService } from './stats.service.js';

export const LB_KEY = 'lb:coins';
/** Set together with the ZSET by every rebuild: no marker means Redis lost the data (restart). */
export const LB_BUILT_KEY = 'lb:coins:built';
const TOP = 50;
const CHUNK = 1000;

/**
 * Plan §15. Redis ZSET `lb:coins` is an index over `player_stats`, never the source of truth:
 * when Redis is down (or empty after a restart) every read is answered from Postgres instead, so
 * the leaderboard stays correct, just slower. The ZSET is rebuilt on boot, daily, and after a
 * missed update.
 */
export class LeaderboardService {
  /** A ZSET write was skipped (Redis down): the next maintenance pass rebuilds. */
  dirty = false;

  constructor(
    private readonly d: {
      db: Db;
      redis: SafeRedis;
      users: UserDirectory;
      stats: StatsService;
      logger: Logger;
      nodeId: string;
    },
  ) {}

  // ---------------- writes (after commit, from rating.stats.changed) ----------------

  async apply(u: { userId: string; coins: number; hidden: boolean; updatedAt: string }): Promise<void> {
    const ok = await this.d.redis.run(
      async (r) => {
        if (u.hidden) await r.zrem(LB_KEY, u.userId);
        else await r.zadd(LB_KEY, leaderboardScore(u.coins, new Date(u.updatedAt)), u.userId);
        return true;
      },
      () => false,
    );
    if (!ok) this.dirty = true;
  }

  /**
   * Build `lb:coins:tmp:<node>` from Postgres and RENAME it over `lb:coins` (atomic swap). Rows
   * that changed while it ran are re-applied afterwards so a concurrent update isn't lost.
   */
  async rebuild(): Promise<boolean> {
    const startedAt = new Date();
    const tmp = `${LB_KEY}:tmp:${this.d.nodeId}`;
    const ok = await this.d.redis.run(
      async (r) => {
        await r.del(tmp);
        let n = 0;
        let after: { coins: number; userId: string } | undefined;
        for (;;) {
          const rows = await this.d.db
            .select({
              userId: playerStats.userId,
              coins: playerStats.coins,
              updatedAt: playerStats.updatedAt,
            })
            .from(playerStats)
            .where(
              and(
                not(playerStats.isAdmin),
                after
                  ? or(
                      lt(playerStats.coins, after.coins),
                      and(eq(playerStats.coins, after.coins), gt(playerStats.userId, after.userId)),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(playerStats.coins), asc(playerStats.userId))
            .limit(CHUNK);
          if (!rows.length) break;
          const args = rows.flatMap((x) => [leaderboardScore(x.coins, x.updatedAt), x.userId]);
          await r.zadd(tmp, ...args);
          n += rows.length;
          const last = rows.at(-1)!;
          after = { coins: last.coins, userId: last.userId };
          if (rows.length < CHUNK) break;
        }
        const tx = r.multi();
        if (n) tx.rename(tmp, LB_KEY);
        else tx.del(LB_KEY);
        tx.set(LB_BUILT_KEY, startedAt.toISOString());
        await tx.exec();

        // anything committed while we read (or just before) goes in again on top
        const recent = await this.d.db
          .select()
          .from(playerStats)
          .where(gte(playerStats.updatedAt, new Date(startedAt.getTime() - 30_000)));
        for (const x of recent) {
          if (x.isAdmin) await r.zrem(LB_KEY, x.userId);
          else await r.zadd(LB_KEY, leaderboardScore(x.coins, x.updatedAt), x.userId);
        }
        this.d.logger.info({ players: n }, 'leaderboard rebuilt');
        return true;
      },
      () => false,
    );
    if (ok) this.dirty = false;
    return ok;
  }

  /** A write was missed here, or Redis lost the index (restart without persistence). */
  async needsRebuild(): Promise<boolean> {
    if (this.dirty) return true;
    return this.d.redis.run(
      async (r) => !(await r.exists(LB_BUILT_KEY)),
      () => false,
    );
  }

  // ---------------- reads ----------------

  async global(viewerId: string | undefined): Promise<Leaderboard> {
    const fromRedis = await this.d.redis.run(
      async (r) => {
        if (!(await r.exists(LB_BUILT_KEY))) return null; // lost its data: Postgres answers until rebuilt
        const top = await r.zrevrange(LB_KEY, 0, TOP - 1);
        let me: { rank: number | null } | undefined;
        if (viewerId) {
          const rank = await r.zrevrank(LB_KEY, viewerId);
          me = { rank: rank === null ? null : rank + 1 };
        }
        return { top, me };
      },
      () => null,
    );
    if (!fromRedis) return this.globalFromPostgres(viewerId);

    const rows = new Map((await this.d.stats.rows(fromRedis.top)).map((r) => [r.userId, r]));
    const ordered = fromRedis.top.map((id) => rows.get(id)).filter((r): r is PlayerStatsRow => !!r);
    return {
      scope: 'global',
      items: await this.entries(ordered, 1),
      me: viewerId ? await this.myRank(viewerId, fromRedis.me?.rank ?? null) : null,
      fallback: false,
    };
  }

  /** Friends and me, ranked among ourselves (a short list: straight from Postgres). */
  async friends(viewerId: string): Promise<Leaderboard> {
    const ids = [...new Set([viewerId, ...(await this.d.users.friendIds(viewerId))])];
    const rows = (await this.d.stats.rows(ids))
      .filter((r) => !r.isAdmin || r.userId === viewerId)
      .sort(byRank);
    const mine = rows.findIndex((r) => r.userId === viewerId);
    const self = rows[mine];
    return {
      scope: 'friends',
      items: await this.entries(rows, 1),
      me: self ? { rank: mine + 1, coins: self.coins, level: self.level } : await this.myRank(viewerId, null),
      fallback: false,
    };
  }

  /** Where the viewer stands globally (the "your rank" strip). */
  async me(viewerId: string): Promise<MyRank> {
    const rank = await this.d.redis.run(
      async (r) => {
        if (!(await r.exists(LB_BUILT_KEY))) return undefined;
        const v = await r.zrevrank(LB_KEY, viewerId);
        return v === null ? null : v + 1;
      },
      () => undefined,
    );
    if (rank === undefined) return this.myRankFromPostgres(viewerId);
    return this.myRank(viewerId, rank);
  }

  private async globalFromPostgres(viewerId: string | undefined): Promise<Leaderboard> {
    const rows = await this.d.db
      .select()
      .from(playerStats)
      .where(not(playerStats.isAdmin))
      .orderBy(desc(playerStats.coins), asc(SECOND), desc(playerStats.userId))
      .limit(TOP);
    return {
      scope: 'global',
      items: await this.entries(rows, 1),
      me: viewerId ? await this.myRankFromPostgres(viewerId) : null,
      fallback: true,
    };
  }

  /** Rank = how many visible players are ahead + 1 (an index range count). */
  private async myRankFromPostgres(viewerId: string): Promise<MyRank> {
    const [row] = await this.d.stats.rows([viewerId]);
    if (!row) return this.myRank(viewerId, null);
    if (row.isAdmin) return { rank: null, coins: row.coins, level: row.level };
    const [ahead] = await this.d.db
      .select({ n: count() })
      .from(playerStats)
      .where(
        and(
          not(playerStats.isAdmin),
          or(
            gt(playerStats.coins, row.coins),
            and(eq(playerStats.coins, row.coins), lt(SECOND, epochSec(row.updatedAt))),
            and(
              eq(playerStats.coins, row.coins),
              eq(SECOND, epochSec(row.updatedAt)),
              gt(playerStats.userId, row.userId),
            ),
          ),
        ),
      );
    return { rank: (ahead?.n ?? 0) + 1, coins: row.coins, level: row.level };
  }

  private async myRank(viewerId: string, rank: number | null): Promise<MyRank> {
    const s = await this.d.stats.get(viewerId);
    return { rank, coins: s.coins, level: s.level };
  }

  private async entries(rows: PlayerStatsRow[], firstRank: number): Promise<LeaderboardEntry[]> {
    let people = new Map<string, Player>();
    try {
      people = await this.d.users.players(rows.map((r) => r.userId));
    } catch (err) {
      this.d.logger.warn({ err }, 'profiles unavailable for the leaderboard');
    }
    return rows.map((r, i) => {
      const p = people.get(r.userId);
      return {
        rank: firstRank + i,
        userId: r.userId,
        username: p?.username ?? 'player',
        fullname: p?.fullname ?? '',
        avatarUrl: p?.avatarUrl ?? null,
        coins: r.coins,
        level: r.level,
        wins: r.wins,
        losses: r.losses,
      };
    });
  }
}

/**
 * Exactly the ZSET's order, so Redis and the Postgres fallback agree: more coins first, then
 * whoever got there earlier (whole seconds, as in the score), then ZREVRANGE's tie order (member
 * descending).
 */
const epochSec = (d: Date) => Math.floor(d.getTime() / 1000);
const SECOND = sql<number>`floor(extract(epoch from ${playerStats.updatedAt}))::bigint`;
const byRank = (a: PlayerStatsRow, b: PlayerStatsRow) =>
  b.coins - a.coins ||
  epochSec(a.updatedAt) - epochSec(b.updatedAt) ||
  (a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0);
