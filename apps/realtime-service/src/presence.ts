import type { PresenceStatus } from '@cb/contracts';
import type { SafeRedis } from '@cb/redis';

/**
 * Presence in Redis (plan §13.3):
 * - `presence:{userId}`: HASH connId → nodeId, expires 60 s after the last ping;
 * - `presence:online`: ZSET userId → last seen (ms), for the paginated lobby list;
 * - `presence:online:lex`: ZSET of `username:userId` (score 0) for prefix search;
 * - `inmatch:{userId}`: set while the user is in a match.
 * Everything degrades to "unknown/offline" when Redis is down; delivery doesn't use any of it.
 */
export const CONNECTION_TTL_MS = 60_000;
const STALE_MS = 90_000;
const k = {
  conns: (u: string) => `presence:{${u}}`,
  online: 'presence:online',
  lex: 'presence:online:lex',
  lexOf: 'presence:lexmember',
  inMatch: (u: string) => `inmatch:${u}`,
  ticket: (jti: string) => `ticket:${jti}`,
  matchUsers: (m: string) => `match-users:${m}`,
};

export class PresenceStore {
  constructor(
    private readonly r: SafeRedis,
    private readonly nodeId: string,
  ) {}

  /** Single use for socket tickets. Redis down → accept (the 60 s expiry limits the risk). */
  claimTicket(jti: string): Promise<boolean> {
    return this.r.run(
      async (c) => (await c.set(k.ticket(jti), '1', 'EX', 120, 'NX')) === 'OK',
      () => true,
    );
  }

  /** Register a connection; returns how many the user has now. */
  connect(userId: string, connId: string, username: string): Promise<number> {
    const member = `${username.toLowerCase()}:${userId}`;
    return this.r.run(
      async (c) => {
        const res = await c
          .multi()
          .hset(k.conns(userId), connId, this.nodeId)
          .pexpire(k.conns(userId), CONNECTION_TTL_MS)
          .zadd(k.online, Date.now(), userId)
          .zadd(k.lex, 0, member)
          .hset(k.lexOf, userId, member)
          .hlen(k.conns(userId))
          .exec();
        return Number(res?.[5]?.[1] ?? 1);
      },
      () => 1,
    );
  }

  /**
   * Keep live connections registered: the client's `presence:ping` (every 25 s) and the node's own
   * heartbeat both land here. It re-writes the connection, not only its expiry: browsers throttle
   * timers in background tabs to about once a minute, so the hash can expire while the socket is
   * still open, and a bare PEXPIRE on a missing key would leave a connected user "offline".
   */
  async refresh(conns: { userId: string; connId: string }[]): Promise<void> {
    if (!conns.length) return;
    await this.r.run(
      async (c) => {
        const m = c.multi();
        const now = Date.now();
        for (const { userId, connId } of conns) {
          m.hset(k.conns(userId), connId, this.nodeId)
            .pexpire(k.conns(userId), CONNECTION_TTL_MS)
            .zadd(k.online, now, userId);
        }
        await m.exec();
      },
      () => undefined,
    );
  }

  ping(userId: string, connId: string): Promise<void> {
    return this.refresh([{ userId, connId }]);
  }

  /** Remove a connection; returns how many are left. */
  disconnect(userId: string, connId: string): Promise<number> {
    return this.r.run(
      async (c) => {
        const res = await c.multi().hdel(k.conns(userId), connId).hlen(k.conns(userId)).exec();
        return Number(res?.[1]?.[1] ?? 0);
      },
      () => 0,
    );
  }

  /** After the debounce: still no connection anywhere → take the user out of the lists. */
  markOffline(userId: string): Promise<boolean> {
    return this.r.run(
      async (c) => {
        if (await c.exists(k.conns(userId))) return false;
        const member = await c.hget(k.lexOf, userId);
        const m = c.multi().zrem(k.online, userId).hdel(k.lexOf, userId);
        if (member) m.zrem(k.lex, member);
        await m.exec();
        return true;
      },
      () => false,
    );
  }

  statuses(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    const offline = () => Object.fromEntries(userIds.map((id) => [id, 'offline' as const]));
    if (!userIds.length) return Promise.resolve({});
    return this.r.run(async (c) => {
      const p = c.pipeline();
      for (const id of userIds) p.exists(k.conns(id)).exists(k.inMatch(id));
      const res = (await p.exec()) ?? [];
      const out: Record<string, PresenceStatus> = {};
      userIds.forEach((id, i) => {
        const online = Number(res[2 * i]?.[1] ?? 0) > 0;
        const inMatch = Number(res[2 * i + 1]?.[1] ?? 0) > 0;
        out[id] = !online ? 'offline' : inMatch ? 'in_match' : 'online';
      });
      return out;
    }, offline);
  }

  async setInMatch(matchId: string, userIds: string[]): Promise<void> {
    await this.r.run(
      async (c) => {
        const m = c.multi();
        for (const id of userIds) m.set(k.inMatch(id), matchId, 'EX', 3 * 3600);
        m.sadd(k.matchUsers(matchId), ...userIds).expire(k.matchUsers(matchId), 3 * 3600);
        await m.exec();
      },
      () => undefined,
    );
  }

  async clearInMatch(matchId: string, userIds: string[]): Promise<void> {
    await this.r.run(
      async (c) => {
        // only if they're still in *this* match (a later match may have started)
        for (const id of userIds) {
          if ((await c.get(k.inMatch(id))) === matchId) await c.del(k.inMatch(id));
        }
      },
      () => undefined,
    );
  }

  matchUsers(matchId: string): Promise<string[]> {
    return this.r.run(
      (c) => c.smembers(k.matchUsers(matchId)),
      () => [],
    );
  }

  /** Most recently active first; the cursor is the last item's `score:userId`. */
  onlinePage(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ userIds: string[]; nextCursor: string | null }> {
    return this.r.run(
      async (c) => {
        const max = cursor ? `(${cursor.split(':')[0]}` : '+inf';
        const raw = await c.zrevrangebyscore(k.online, max, '-inf', 'WITHSCORES', 'LIMIT', 0, limit + 1);
        const rows: { id: string; score: string }[] = [];
        for (let i = 0; i < raw.length; i += 2) rows.push({ id: raw[i]!, score: raw[i + 1]! });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          userIds: page.map((r) => r.id),
          nextCursor: rows.length > limit && last ? `${last.score}:${last.id}` : null,
        };
      },
      () => ({ userIds: [], nextCursor: null }),
    );
  }

  /** Username prefix search over online players (lexicographic ZSET). */
  search(prefix: string, limit: number): Promise<string[]> {
    const p = prefix.toLowerCase();
    return this.r.run(
      async (c) =>
        (await c.zrangebylex(k.lex, `[${p}`, `[${p}\xff`, 'LIMIT', 0, limit)).map((m) =>
          m.slice(m.lastIndexOf(':') + 1),
        ),
      () => [],
    );
  }

  count(): Promise<number> {
    return this.r.run(
      (c) => c.zcard(k.online),
      () => 0,
    );
  }

  /** Leader-ish sweeper (best effort): drop users whose connection hashes expired. */
  sweep(): Promise<number> {
    return this.r.run(
      async (c) => {
        if ((await c.set('presence:sweeper', this.nodeId, 'PX', 25_000, 'NX')) !== 'OK') return 0;
        const stale = await c.zrangebyscore(k.online, '-inf', Date.now() - STALE_MS, 'LIMIT', 0, 500);
        let n = 0;
        for (const id of stale) if (await this.markOffline(id)) n++;
        return n;
      },
      () => 0,
    );
  }
}
