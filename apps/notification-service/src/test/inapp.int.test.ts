import { generateSigningKey, JwtVerifier, TokenSigner } from '@cb/auth';
import { TOPICS, type EventEnvelope, type Notification, type Player } from '@cb/contracts';
import { createProducer, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { and, eq } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { notifications } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import type { UserDirectory } from '../modules/inapp/users.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'notification-inapp-int', level: 'silent' });

let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let signer: TokenSigner;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let producer: Producer;

const known = new Map<string, Player>();
const users: UserDirectory = {
  players: async (ids) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!])),
};

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  signer = await TokenSigner.create([await generateSigningKey('n')]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: 'notification-test-internal-secret-0123456789',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger, { verifier: new JwtVerifier({ jwks: signer.publicJwks() }), users });
  worker = await startWorker(infra, { fromBeginning: true });
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

async function person(name = `p_${newId().slice(-6)}`) {
  const id = newId();
  known.set(id, { id, username: name, fullname: `Player ${name}`, avatarUrl: null });
  const token = (await signer.signAccess({ userId: id, role: 'user', emailVerified: true }, 900)).token;
  return { id, name, token };
}

const envelope = (type: string, key: string, data: object): EventEnvelope<unknown> => ({
  id: newId(),
  type,
  source: 'test',
  occurredAt: new Date().toISOString(),
  aggregateId: key,
  data,
});
const send = (topic: string, key: string, ...envs: EventEnvelope<unknown>[]) =>
  producer.send({ topic, messages: envs.map((e) => ({ key, value: JSON.stringify(e) })) });

const call = (method: 'GET' | 'POST', url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
const list = async (token: string): Promise<Notification[]> => {
  const r = await call('GET', '/api/v1/notifications', token);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items;
};
const unread = async (token: string): Promise<number> =>
  (await call('GET', '/api/v1/notifications/unread-count', token)).json().count;

const rowsOf = (userId: string) =>
  infra.db.db.select().from(notifications).where(eq(notifications.userId, userId));

const friendship = (low: string, high: string, change: string, actorId: string) => {
  const [a, b] = [low, high].sort() as [string, string];
  return envelope('user.friendship.changed.v1', a, {
    userLow: a,
    userHigh: b,
    change,
    actorId,
    targetId: actorId === a ? b : a,
    at: new Date().toISOString(),
  });
};

// ---------------- tests ----------------

describe('in-app notifications', () => {
  it('friend request → the recipient gets it; accepting clears it and tells the requester', async () => {
    const [a, b] = [await person(), await person()];
    const req = friendship(a.id, b.id, 'requested', a.id);
    await send(TOPICS.user, req.aggregateId, req, req); // redelivered
    await waitFor(async () => (await unread(b.token)) === 1 || undefined, {
      what: 'request',
      timeoutMs: 30_000,
    });
    const [n] = await list(b.token);
    expect(n).toMatchObject({
      type: 'friend_request',
      readAt: null,
      payload: { from: { id: a.id, username: a.name } },
    });

    const acc = friendship(a.id, b.id, 'accepted', b.id);
    await send(TOPICS.user, acc.aggregateId, acc);
    await waitFor(async () => (await unread(a.token)) === 1 || undefined, {
      what: 'accepted',
      timeoutMs: 30_000,
    });
    expect((await list(a.token))[0]).toMatchObject({
      type: 'friend_accepted',
      payload: { by: { id: b.id } },
    });
    expect(await unread(b.token)).toBe(0); // answered → read
    expect(await rowsOf(b.id)).toHaveLength(1);

    // every change goes out for realtime, addressed to its owner
    const evs = await infra.db.db.select().from(outbox).where(eq(outbox.key, b.id));
    expect(evs.map((e) => [e.type, (e.payload as EventEnvelope<unknown>).recipients])).toEqual([
      ['notification.notification.upserted.v1', [b.id]],
      ['notification.notification.upserted.v1', [b.id]],
    ]);
  });

  it('a cancelled friend request is read for the recipient', async () => {
    const [a, b] = [await person(), await person()];
    const req = friendship(a.id, b.id, 'requested', a.id);
    await send(TOPICS.user, req.aggregateId, req);
    await waitFor(async () => (await unread(b.token)) === 1 || undefined, {
      what: 'request',
      timeoutMs: 30_000,
    });
    const can = friendship(a.id, b.id, 'cancelled', a.id);
    await send(TOPICS.user, can.aggregateId, can);
    await waitFor(async () => (await unread(b.token)) === 0 || undefined, { what: 'cleared' });
  });

  it('challenges: one notification per challenge; answered → read, expired → stays unread (missed)', async () => {
    const [a, b] = [await person(), await person()];
    const base = (challengeId: string) => ({ challengeId, fromUserId: a.id, toUserId: b.id });
    const created = (challengeId: string) =>
      envelope('battle.challenge.created.v1', challengeId, {
        ...base(challengeId),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        from: { username: a.name, fullname: `Player ${a.name}`, avatarUrl: null },
      });
    const [c1, c2] = [newId(), newId()];
    // a re-published copy (new envelope id) must not make a second row
    const first = created(c1);
    await send(TOPICS.battle, c1, first, { ...first, id: newId() });
    await send(TOPICS.battle, c2, created(c2));
    await waitFor(async () => (await unread(b.token)) === 2 || undefined, { what: 'two', timeoutMs: 30_000 });

    await send(TOPICS.battle, c1, envelope('battle.challenge.rejected.v1', c1, base(c1)));
    await send(TOPICS.battle, c2, envelope('battle.challenge.expired.v1', c2, base(c2)));
    await waitFor(
      async () => {
        const items = await list(b.token);
        const s = (id: string) =>
          items.find((n) => n.type === 'challenge_received' && n.payload.challengeId === id);
        const one = s(c1);
        const two = s(c2);
        return one?.type === 'challenge_received' &&
          one.payload.status === 'rejected' &&
          two?.type === 'challenge_received' &&
          two.payload.status === 'expired'
          ? { one, two }
          : undefined;
      },
      { what: 'closed', timeoutMs: 30_000 },
    );
    const items = await list(b.token);
    expect(items).toHaveLength(2);
    expect(
      items.find((n) => n.payload && 'challengeId' in n.payload && n.payload.challengeId === c1)?.readAt,
    ).not.toBeNull();
    expect(await unread(b.token)).toBe(1); // the missed one
  });

  it('match result + coin change merge into one notification, whichever event comes first', async () => {
    const [a, b] = [await person(), await person()];
    const matchId = newId();
    const stats = (userId: string, delta: number, reason: string, inMatch = matchId) =>
      envelope('rating.stats.changed.v1', userId, {
        userId,
        coins: 400 + delta,
        level: 1,
        wins: 0,
        losses: 0,
        draws: 0,
        streak: 0,
        bestStreak: 0,
        delta,
        reason,
        matchId: inMatch,
        hidden: false,
        updatedAt: new Date().toISOString(),
      });
    // b's coin change arrives before the result; a's after
    await send(TOPICS.rating, b.id, stats(b.id, -50, 'match_loss'));
    await waitFor(async () => (await rowsOf(b.id)).length === 1 || undefined, {
      what: 'b stats',
      timeoutMs: 30_000,
    });
    const done = envelope('battle.match.completed.v1', matchId, {
      matchId,
      problemId: newId(),
      userIds: [a.id, b.id],
      winnerId: a.id,
      endReason: 'solved',
      results: { [a.id]: 'win', [b.id]: 'loss' },
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      version: 3,
    });
    await send(TOPICS.battle, matchId, done, done);
    await send(TOPICS.rating, a.id, stats(a.id, 50, 'match_win'));

    const full = (n: Notification | undefined) =>
      n?.type === 'match_result' && n.payload.result !== null && n.payload.coinDelta !== null ? n : undefined;
    const na = await waitFor(async () => full((await list(a.token))[0]), {
      what: 'a merged',
      timeoutMs: 30_000,
    });
    const nb = await waitFor(async () => full((await list(b.token))[0]), {
      what: 'b merged',
      timeoutMs: 30_000,
    });
    expect(na.payload).toEqual({
      matchId,
      result: 'win',
      endReason: 'solved',
      opponent: { id: b.id, username: b.name, fullname: `Player ${b.name}`, avatarUrl: null },
      coinDelta: 50,
    });
    expect(nb.payload).toMatchObject({ result: 'loss', coinDelta: -50, opponent: { id: a.id } });
    expect(await rowsOf(a.id)).toHaveLength(1);
    expect(await rowsOf(b.id)).toHaveLength(1);

    // a hint bought in that match is a coin change too, but not the match's result
    await send(TOPICS.rating, a.id, stats(a.id, -10, 'hint_1'));
    // same partition, so once this second match shows up the hint charge was handled
    await send(TOPICS.rating, a.id, stats(a.id, 50, 'match_win', newId()));
    await waitFor(async () => (await rowsOf(a.id)).length === 2 || undefined, {
      what: 'a marker',
      timeoutMs: 30_000,
    });
    const first = (await list(a.token)).find(
      (n) => n.type === 'match_result' && n.payload.matchId === matchId,
    );
    expect(first?.payload).toMatchObject({ result: 'win', coinDelta: 50 });
  });

  it('read one, read all, pagination, and nobody reads anyone else’s', async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    for (const other of [b, c]) {
      const req = friendship(a.id, other.id, 'requested', other.id);
      await send(TOPICS.user, req.aggregateId, req);
    }
    await waitFor(async () => (await unread(a.token)) === 2 || undefined, {
      what: 'two requests',
      timeoutMs: 30_000,
    });

    const page1 = await call('GET', '/api/v1/notifications?limit=1', a.token);
    expect(page1.json().items).toHaveLength(1);
    const page2 = await call(
      'GET',
      `/api/v1/notifications?limit=1&cursor=${page1.json().nextCursor}`,
      a.token,
    );
    expect(page2.json()).toMatchObject({ nextCursor: null });
    expect(page2.json().items[0].id).not.toBe(page1.json().items[0].id);

    const id = page1.json().items[0].id as string;
    expect((await call('POST', `/api/v1/notifications/${id}/read`, b.token)).statusCode).toBe(404);
    const r = await call('POST', `/api/v1/notifications/${id}/read`, a.token);
    expect(r.json().readAt).not.toBeNull();
    expect(await unread(a.token)).toBe(1);
    expect((await call('POST', '/api/v1/notifications/read-all', a.token)).json()).toEqual({ updated: 1 });
    expect(await unread(a.token)).toBe(0);
    const [row] = await infra.db.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, a.id), eq(notifications.id, id)));
    expect(row?.readAt).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode).toBe(401);
  });
});
