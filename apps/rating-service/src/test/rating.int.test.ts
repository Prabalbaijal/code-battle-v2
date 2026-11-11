import { generateSigningKey, JwtVerifier, TokenSigner } from '@cb/auth';
import { TOPICS, type EventEnvelope, type Leaderboard, type Player } from '@cb/contracts';
import { createProducer, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { and, eq } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { UserDirectory } from '../clients.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { coinLedger, playerStats } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import { LB_BUILT_KEY, LB_KEY } from '../modules/leaderboard.service.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'rating-int', level: 'silent' });

let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let signer: TokenSigner;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let producer: Producer;

const known = new Map<string, Player>();
const friendsOf = new Map<string, string[]>();
const users: UserDirectory = {
  players: async (ids) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!])),
  friendIds: async (id) => friendsOf.get(id) ?? [],
};

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  signer = await TokenSigner.create([await generateSigningKey('r')]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: 'rating-test-internal-secret-0123456789ab',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger, { verifier: new JwtVerifier({ jwks: signer.publicJwks() }), users });
  worker = await startWorker(infra, { fromBeginning: true, maintenanceEveryMs: 300 });
  app = await buildApp(infra);
  producer = createProducer(infra.kafka);
  await producer.connect();
}, 240_000);

afterAll(async () => {
  await producer?.disconnect();
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), redis?.stop(), rp?.stop()]);
});

// ---------------- helpers ----------------

const envelope = (type: string, source: string, key: string, data: object): EventEnvelope<unknown> => ({
  id: newId(),
  type,
  source,
  occurredAt: new Date().toISOString(),
  aggregateId: key,
  data,
});
const send = (topic: string, key: string, ...envs: EventEnvelope<unknown>[]) =>
  producer.send({ topic, messages: envs.map((e) => ({ key, value: JSON.stringify(e) })) });

const stats = async (userId: string) =>
  (await infra.db.db.select().from(playerStats).where(eq(playerStats.userId, userId)))[0];

/** A registered player whose stats row exists and who is on the ZSET. */
async function register(name = `p_${newId().slice(-6)}`, role: 'user' | 'admin' = 'user') {
  const id = newId();
  known.set(id, { id, username: name, fullname: `Player ${name}`, avatarUrl: null });
  await send(
    TOPICS.user,
    id,
    envelope('identity.user.registered.v1', 'identity-service', id, {
      userId: id,
      username: name,
      fullname: `Player ${name}`,
      role,
      registeredAt: new Date().toISOString(),
    }),
  );
  await waitFor(() => stats(id), { what: `stats for ${name}`, timeoutMs: 30_000 });
  if (role === 'user') {
    await waitFor(async () => (await infra.redis.zscore(LB_KEY, id)) !== null, { what: 'on the zset' });
  }
  const token = (await signer.signAccess({ userId: id, role, emailVerified: true }, 900)).token;
  return { id, name, token };
}

function completed(
  matchId: string,
  endReason: 'solved' | 'forfeit' | 'timeout',
  results: Record<string, 'win' | 'loss' | 'draw'>,
) {
  const userIds = Object.keys(results);
  return envelope('battle.match.completed.v1', 'battle-service', matchId, {
    matchId,
    problemId: newId(),
    userIds,
    winnerId: Object.entries(results).find(([, r]) => r === 'win')?.[0] ?? null,
    endReason,
    results,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    version: 3,
  });
}

const board = async (token?: string, scope = 'global'): Promise<Leaderboard> => {
  const r = await app.inject({
    method: 'GET',
    url: `/api/v1/leaderboard?scope=${scope}`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const zsetCoins = async (id: string) => {
  const s = await infra.redis.zscore(LB_KEY, id);
  return s === null ? null : Math.floor(Number(s) / 1e10);
};

// ---------------- tests ----------------

describe('rating-service', () => {
  it('a new player starts with 400 coins and a signup ledger row, and appears on the leaderboard', async () => {
    const p = await register();
    expect(await stats(p.id)).toMatchObject({ coins: 400, level: 1, wins: 0, isAdmin: false });
    const r = await get('/api/v1/stats/me/ledger', p.token);
    expect(r.json().items).toEqual([
      expect.objectContaining({ reason: 'signup_bonus', delta: 400, applied: 400, balanceAfter: 400 }),
    ]);
    expect(await zsetCoins(p.id)).toBe(400);
    // a stats event for the player (realtime pushes it as stats:updated)
    const evs = await infra.db.db.select().from(outbox).where(eq(outbox.key, p.id));
    expect(evs.map((e) => [e.type, (e.payload as EventEnvelope<unknown>).recipients])).toEqual([
      ['rating.stats.changed.v1', [p.id]],
    ]);
  });

  it('DoD: replaying match.completed 5× (same and re-published envelopes) changes coins once', async () => {
    const [a, b] = [await register(), await register()];
    const matchId = newId();
    const e = completed(matchId, 'solved', { [a.id]: 'win', [b.id]: 'loss' });
    const republished = Array.from({ length: 5 }, () => ({ ...e, id: newId() }));
    await send(TOPICS.battle, matchId, e, e, e, e, e, ...republished);

    await waitFor(async () => ((await stats(a.id))?.coins === 450 ? true : undefined), {
      what: 'win applied',
      timeoutMs: 30_000,
    });
    // let every copy go through, then check nothing moved twice
    await waitFor(async () => ((await zsetCoins(b.id)) === 350 ? true : undefined), { what: 'zset' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await stats(a.id)).toMatchObject({ coins: 450, wins: 1, losses: 0, currentStreak: 1, level: 1 });
    expect(await stats(b.id)).toMatchObject({ coins: 350, wins: 0, losses: 1, currentStreak: 0 });
    const rows = await infra.db.db.select().from(coinLedger).where(eq(coinLedger.matchId, matchId));
    expect(rows.map((r) => [r.userId, r.reason, r.applied]).sort()).toEqual(
      [
        [a.id, 'match_win', 50],
        [b.id, 'match_loss', -50],
      ].sort(),
    );
    expect(await zsetCoins(a.id)).toBe(450);
  });

  it('timeout costs both 50, floored at 0; the ledger keeps the asked delta and the real change', async () => {
    const [a, b] = [await register(), await register()];
    await infra.db.db.update(playerStats).set({ coins: 30 }).where(eq(playerStats.userId, b.id));
    const matchId = newId();
    await send(TOPICS.battle, matchId, completed(matchId, 'timeout', { [a.id]: 'draw', [b.id]: 'draw' }));
    await waitFor(async () => ((await stats(b.id))?.coins === 0 ? true : undefined), {
      what: 'timeout applied',
      timeoutMs: 30_000,
    });
    expect(await stats(a.id)).toMatchObject({ coins: 350, draws: 1 });
    const [row] = await infra.db.db
      .select()
      .from(coinLedger)
      .where(and(eq(coinLedger.matchId, matchId), eq(coinLedger.userId, b.id)));
    expect(row).toMatchObject({ reason: 'match_timeout', delta: -50, applied: -30, balanceAfter: 0 });
    const ledger = await get(`/api/v1/stats/me/ledger?matchIds=${matchId}`, b.token);
    expect(ledger.json().items).toEqual([expect.objectContaining({ delta: -50, applied: -30 })]);
  });

  it('forfeit: the leaver loses 50 and the opponent wins 50; streaks and levels follow', async () => {
    const [a, b] = [await register(), await register()];
    await infra.db.db
      .update(playerStats)
      .set({ coins: 480, currentStreak: 2, bestStreak: 2 })
      .where(eq(playerStats.userId, a.id));
    const matchId = newId();
    await send(TOPICS.battle, matchId, completed(matchId, 'forfeit', { [a.id]: 'win', [b.id]: 'loss' }));
    await waitFor(async () => ((await stats(a.id))?.coins === 530 ? true : undefined), {
      what: 'forfeit applied',
      timeoutMs: 30_000,
    });
    expect(await stats(a.id)).toMatchObject({ level: 2, currentStreak: 3, bestStreak: 3 });
    expect(await stats(b.id)).toMatchObject({ coins: 350 });
    const r = await get(`/api/v1/stats/${a.id}`, b.token);
    expect(r.json()).toMatchObject({ coins: 530, level: 2, wins: 1, streak: 3, bestStreak: 3 });
  });

  it('ranks: global top, my rank, friends; admins are left off', async () => {
    const top = await register();
    await infra.db.db
      .update(playerStats)
      .set({ coins: 5000, level: 4 })
      .where(eq(playerStats.userId, top.id));
    await infra.leaderboard.rebuild();
    const admin = await register(undefined, 'admin');
    await infra.db.db
      .update(playerStats)
      .set({ coins: 9000, level: 4 })
      .where(eq(playerStats.userId, admin.id));
    await infra.leaderboard.rebuild();

    const g = await board(top.token);
    expect(g.fallback).toBe(false);
    expect(g.items[0]).toMatchObject({ rank: 1, userId: top.id, username: top.name, coins: 5000, level: 4 });
    expect(g.items.some((i) => i.userId === admin.id)).toBe(false);
    expect(g.me).toEqual({ rank: 1, coins: 5000, level: 4 });
    expect((await board(admin.token)).me).toMatchObject({ rank: null, coins: 9000 });
    expect((await board()).me).toBeNull(); // signed out: still public

    // promoting a player takes them off the board (role_changed → stats.changed hidden → ZREM)
    const promoted = await register();
    await send(
      TOPICS.user,
      promoted.id,
      envelope('identity.user.role_changed.v1', 'identity-service', promoted.id, {
        userId: promoted.id,
        role: 'admin',
        previousRole: 'user',
        actorId: admin.id,
      }),
    );
    await waitFor(async () => ((await zsetCoins(promoted.id)) === null ? true : undefined), {
      what: 'removed from zset',
      timeoutMs: 30_000,
    });

    const f1 = await register();
    const f2 = await register();
    await infra.db.db.update(playerStats).set({ coins: 700, level: 2 }).where(eq(playerStats.userId, f2.id));
    friendsOf.set(f1.id, [f2.id, top.id]);
    const fr = await board(f1.token, 'friends');
    expect(fr.items.map((i) => [i.rank, i.userId])).toEqual([
      [1, top.id],
      [2, f2.id],
      [3, f1.id],
    ]);
    expect(fr.me).toMatchObject({ rank: 3, coins: 400 });
    const me = await get('/api/v1/leaderboard/me', f2.token);
    expect(me.json()).toMatchObject({ coins: 700 });
    expect(me.json().rank).toBeGreaterThan(1);
  });

  it('Redis loses its data (flush): Postgres answers the same, then the index is rebuilt', async () => {
    const viewer = await register();
    await infra.leaderboard.rebuild(); // earlier tests edited coins in SQL, behind the index's back
    const before = await board(viewer.token);
    await infra.redis.flushall();
    const during = await board(viewer.token);
    expect(during.fallback).toBe(true);
    expect(during.items).toEqual(before.items);
    expect(during.me).toEqual(before.me);
    // the worker notices the missing marker and rebuilds
    await waitFor(async () => ((await infra.redis.exists(LB_BUILT_KEY)) ? true : undefined), {
      what: 'rebuilt after flush',
      timeoutMs: 15_000,
    });
    const after = await board(viewer.token);
    expect(after.fallback).toBe(false);
    expect(after.items).toEqual(before.items);
  });

  // last: the Redis container does not come back
  it('DoD: with Redis stopped the leaderboard is still correct, including changes made meanwhile', async () => {
    const [a, b] = [await register(), await register()];
    await infra.leaderboard.rebuild();
    const before = await board(a.token);
    expect(before.fallback).toBe(false);

    await redis.stop();
    const down = await board(a.token);
    expect(down.fallback).toBe(true);
    expect(down.items).toEqual(before.items);
    expect(down.me).toEqual(before.me);

    // a match finishes while Redis is down: coins move in Postgres and the board follows
    const matchId = newId();
    await send(TOPICS.battle, matchId, completed(matchId, 'solved', { [a.id]: 'win', [b.id]: 'loss' }));
    await waitFor(async () => ((await stats(a.id))?.coins === 450 ? true : undefined), {
      what: 'applied without redis',
      timeoutMs: 30_000,
    });
    const after = await board(a.token);
    expect(after.fallback).toBe(true);
    const mine = after.items.find((i) => i.userId === a.id);
    if (mine) expect(mine.coins).toBe(450);
    expect(after.me).toMatchObject({ coins: 450 });
    expect(after.me!.rank).toBeLessThan(before.me!.rank!);
    const r = await get('/api/v1/leaderboard/me', a.token);
    expect(r.json()).toEqual(after.me);
    // the ZSET write was skipped: it is rebuilt once Redis is reachable again
    await waitFor(async () => infra.leaderboard.dirty || undefined, { what: 'marked dirty' });
  });
});
