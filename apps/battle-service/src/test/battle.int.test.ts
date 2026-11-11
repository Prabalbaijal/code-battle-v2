import { generateSigningKey, JwtVerifier, signInternalToken, TokenSigner } from '@cb/auth';
import { judgeEvents, TOPICS, type Capacity, type EventEnvelope, type Player } from '@cb/contracts';
import { withTransaction } from '@cb/db';
import { createProducer, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { SelectionError, type UserDirectory } from '../clients.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { challenges, matches, userActiveMatch } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'battle-int', level: 'silent' });
const SECRET = 'battle-test-internal-secret-0123456789ab';
const PROBLEM_ID = newId();

let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let signer: TokenSigner;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let producer: Producer;

// ---------------- stubbed neighbours ----------------

const known = new Map<string, Player>();
const users: UserDirectory = {
  players: async (ids) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!])),
};
const offline = new Set<string>();
let capacity: Capacity = {
  day: '2026-11-12',
  used: 0,
  limit: 100,
  remaining: 100,
  breaker: 'closed',
  level: 'normal',
};
let selectionFails: string | null = null;

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  signer = await TokenSigner.create([await generateSigningKey('b')]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: SECRET,
    MATCH_DURATION_SECONDS: '60',
    CHALLENGE_TTL_SECONDS: '30',
    DECIDE_CAP_SECONDS: '10',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger, {
    verifier: new JwtVerifier({ jwks: signer.publicJwks() }),
    users,
    presence: { isOnline: async (id) => !offline.has(id) },
    judge: { capacity: async () => capacity },
    problems: {
      select: async (matchId) => {
        if (selectionFails) throw new SelectionError(selectionFails, 'no problem');
        return { matchId, problemId: PROBLEM_ID, slug: 'pair-sums' };
      },
    },
  });
  worker = await startWorker(infra, { fromBeginning: true, reconcileEveryMs: 3_600_000 });
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

interface P {
  id: string;
  token: string;
}
async function player(name = `p_${newId().slice(-6)}`): Promise<P> {
  const id = newId();
  known.set(id, { id, username: name, fullname: `Player ${name}`, avatarUrl: null });
  return {
    id,
    token: (await signer.signAccess({ userId: id, role: 'user', emailVerified: true }, 900)).token,
  };
}

const call = (method: 'GET' | 'POST', url: string, as: P, body?: object) =>
  app.inject({
    method,
    url,
    ...(body ? { payload: body } : {}),
    headers: {
      authorization: `Bearer ${as.token}`,
      ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
  });

const challenge = async (from: P, to: P) => {
  const r = await call('POST', '/api/v1/challenges', from, { toUserId: to.id });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
};
const accept = (as: P, id: string) => call('POST', `/api/v1/challenges/${id}/accept`, as);

async function started(): Promise<{ a: P; b: P; matchId: string }> {
  const [a, b] = [await player(), await player()];
  const c = await challenge(a, b);
  const r = await accept(b, c.id);
  expect(r.json()).toMatchObject({ status: 'in_progress' });
  return { a, b, matchId: r.json().matchId };
}

const matchRow = async (id: string) =>
  (await infra.db.db.select().from(matches).where(eq(matches.id, id)))[0]!;
const eventsOf = async (key: string) =>
  (await infra.db.db.select().from(outbox).where(eq(outbox.key, key))).map((e) => e.type);

/** A judge event as the consumer would apply it (same transaction as the inbox). */
async function verdict(matchId: string, userId: string, submittedAt: Date, v: string | null, id = newId()) {
  const base = { submissionId: id, matchId, userId, problemId: PROBLEM_ID, mode: 'submit' as const };
  await withTransaction(infra.db.db, async (tx) => {
    if (v === null) {
      await infra.matches.onSubmissionCreated(tx, { ...base, submittedAt: submittedAt.toISOString() });
    } else {
      await infra.matches.onSubmissionJudged(tx, {
        ...base,
        verdict: v as 'AC',
        failedFile: null,
        failedCase: null,
        maxCpuMs: 10,
        maxMemKb: 1000,
        fromCache: false,
        submittedAt: submittedAt.toISOString(),
        judgedAt: new Date().toISOString(),
      });
    }
  });
  return id;
}
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

// ---------------- challenges (plan §11.1) ----------------

describe('challenges', () => {
  it('create → the recipient sees it; duplicates, self, offline, busy and a tired judge are refused', async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const ch = await challenge(a, b);
    const incoming = (await call('GET', '/api/v1/challenges?direction=incoming', b)).json();
    expect(incoming.items.map((x: { id: string }) => x.id)).toEqual([ch.id]);
    expect(incoming.items[0]).toMatchObject({ from: { id: a.id }, to: { id: b.id }, status: 'pending' });
    expect(await eventsOf(ch.id)).toEqual(['battle.challenge.created.v1']);

    const dup = await call('POST', '/api/v1/challenges', a, { toUserId: b.id });
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'CHALLENGE_ALREADY_PENDING']);
    expect((await call('POST', '/api/v1/challenges', a, { toUserId: a.id })).statusCode).toBe(400);

    offline.add(c.id);
    const off = await call('POST', '/api/v1/challenges', a, { toUserId: c.id });
    expect(off.json().error.code).toBe('OPPONENT_OFFLINE');
    offline.delete(c.id);

    capacity = { ...capacity, level: 'no_new_matches' };
    const tired = await call('POST', '/api/v1/challenges', a, { toUserId: c.id });
    expect([tired.statusCode, tired.json().error.code]).toEqual([503, 'JUDGE_AT_CAPACITY']);
    capacity = { ...capacity, level: 'normal' };

    const { a: busy } = await started();
    const r = await call('POST', '/api/v1/challenges', c, { toUserId: busy.id });
    expect(r.json().error.code).toBe('USER_IN_ACTIVE_MATCH'); // v1 only checked the challenger
  });

  it('reject, cancel and expire are one-way; only the right side may do each', async () => {
    const [a, b] = [await player(), await player()];
    const c1 = await challenge(a, b);
    expect((await call('POST', `/api/v1/challenges/${c1.id}/reject`, a)).statusCode).toBe(409); // not a's to reject
    expect((await call('POST', `/api/v1/challenges/${c1.id}/reject`, b)).json().status).toBe('rejected');
    expect((await call('POST', `/api/v1/challenges/${c1.id}/cancel`, a)).json().error.code).toBe(
      'CHALLENGE_NOT_PENDING',
    );

    const c2 = await challenge(a, b);
    expect((await call('POST', `/api/v1/challenges/${c2.id}/cancel`, a)).json().status).toBe('cancelled');

    const c3 = await challenge(a, b);
    expect(await infra.challenges.expire(c3.id)).toBe(false); // not due yet
    await infra.db.db
      .update(challenges)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(challenges.id, c3.id));
    expect(await infra.challenges.expireOverdue()).toBeGreaterThanOrEqual(1); // the reconciler's backstop
    expect(await infra.challenges.expire(c3.id)).toBe(false); // second time: no-op
    expect(await eventsOf(c3.id)).toEqual(['battle.challenge.created.v1', 'battle.challenge.expired.v1']);
  });
});

// ---------------- start saga (plan §11.2, race matrix §12) ----------------

describe('accept → match start', () => {
  it('accepting starts the match for both: clock set, both locked, participation for the judge', async () => {
    const { a, b, matchId } = await started();
    const m = await matchRow(matchId);
    expect(m).toMatchObject({ status: 'in_progress', problemId: PROBLEM_ID, problemSlug: 'pair-sums' });
    expect(m.endsAt!.getTime() - m.startedAt!.getTime()).toBe(60_000);
    expect(await eventsOf(matchId)).toEqual(['battle.match.started.v1']);
    for (const p of [a, b]) {
      expect((await call('GET', '/api/v1/matches/active', p)).json().match).toMatchObject({ matchId });
    }
    const svc = `Bearer ${await signInternalToken(SECRET, 'judge-service')}`;
    const part = await app.inject({
      method: 'GET',
      url: `/internal/matches/${matchId}/participation?userId=${a.id}`,
      headers: { authorization: svc },
    });
    expect(part.json()).toMatchObject({ participant: true, status: 'in_progress', problemId: PROBLEM_ID });
    const outsider = await app.inject({
      method: 'GET',
      url: `/internal/matches/${matchId}/participation?userId=${newId()}`,
      headers: { authorization: svc },
    });
    expect(outsider.json().participant).toBe(false);
  });

  it('50 parallel accepts (double-click, retries) make exactly one match', async () => {
    const [a, b] = [await player(), await player()];
    const c = await challenge(a, b);
    const rs = await Promise.all(Array.from({ length: 50 }, () => accept(b, c.id)));
    expect(new Set(rs.map((r) => r.statusCode))).toEqual(new Set([200]));
    expect(new Set(rs.map((r) => r.json().matchId)).size).toBe(1);
    const mine = await infra.db.db
      .select()
      .from(userActiveMatch)
      .where(inArray(userActiveMatch.userId, [a.id, b.id]));
    expect(new Set(mine.map((m) => m.matchId)).size).toBe(1);
  });

  it('A→B and B→A accepted at the same moment: one match, the other gets 409', async () => {
    const [a, b] = [await player(), await player()];
    const ab = await challenge(a, b);
    const ba = await challenge(b, a);
    const [r1, r2] = await Promise.all([accept(b, ab.id), accept(a, ba.id)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.statusCode === 409)!.json().error.code).toBe('USER_IN_ACTIVE_MATCH');
  });

  it('accept after expiry is refused', async () => {
    const [a, b] = [await player(), await player()];
    const c = await challenge(a, b);
    await infra.db.db
      .update(challenges)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(challenges.id, c.id));
    const r = await accept(b, c.id);
    expect([r.statusCode, r.json().error.code, r.json().error.message]).toEqual([
      409,
      'CHALLENGE_NOT_PENDING',
      'This challenge has expired',
    ]);
  });

  it('no problem for the pair: the start is compensated (aborted, both freed, told why)', async () => {
    const [a, b] = [await player(), await player()];
    const c = await challenge(a, b);
    selectionFails = 'NO_UNSEEN_PROBLEM';
    const r = await accept(b, c.id);
    selectionFails = null;
    expect(r.json().status).toBe('aborted');
    expect((await call('GET', '/api/v1/matches/active', a)).json().match).toBeNull();
    const [ev] = await infra.db.db
      .select()
      .from(outbox)
      .where(sql`${outbox.key} = ${r.json().matchId} and ${outbox.type} = 'battle.match.aborted.v1'`);
    expect((ev!.payload as { data: { reason: string } }).data.reason).toMatch(/no new problems/);
  });

  it('the reconciler aborts a start that crashed half-way', async () => {
    const [a, b] = [await player(), await player()];
    const id = newId();
    await infra.db.db.insert(matches).values({ id, status: 'created', createdAt: secondsAgo(60) });
    await infra.db.db.insert(userActiveMatch).values([
      { userId: a.id, matchId: id },
      { userId: b.id, matchId: id },
    ]);
    await worker.reconcile();
    expect((await matchRow(id)).status).toBe('aborted');
    expect((await call('GET', '/api/v1/matches/active', a)).json().match).toBeNull();
  });
});

// ---------------- winner, deciding, timeout, forfeit (plan §11.3–11.5) ----------------

describe('finishing a match', () => {
  it('the earliest submitted AC wins even when judged last; players are told after commit', async () => {
    const { a, b, matchId } = await started();
    await verdict(matchId, b.id, secondsAgo(5), 'AC'); // judged first but submitted later…
    // …is still the only AC, so b wins at once: no earlier pending submission exists
    expect(await matchRow(matchId)).toMatchObject({
      status: 'completed',
      winnerId: b.id,
      endReason: 'solved',
    });
    await verdict(matchId, a.id, secondsAgo(10), 'AC'); // too late: the match is over
    expect((await matchRow(matchId)).winnerId).toBe(b.id);
    expect((await eventsOf(matchId)).filter((t) => t === 'battle.match.completed.v1')).toHaveLength(1);
    expect((await call('GET', '/api/v1/matches/active', a)).json().match).toBeNull();
  });

  it("an AC waits for the opponent's earlier pending submission (deciding), then resolves", async () => {
    const { a, b, matchId } = await started();
    await verdict(matchId, a.id, secondsAgo(20), null); // a submitted first, still judging
    await verdict(matchId, b.id, secondsAgo(10), 'AC');
    expect(await matchRow(matchId)).toMatchObject({ status: 'deciding' });
    expect(await eventsOf(matchId)).toContain('battle.match.deciding.v1');
    const state = (await call('GET', `/api/v1/matches/${matchId}/state`, b)).json();
    expect(state).toMatchObject({ status: 'deciding', opponentProgress: { submitted: 1, judged: 0 } });
  });

  it('…and the earlier one being AC makes its author the winner', async () => {
    const { a, b, matchId } = await started();
    const first = await verdict(matchId, a.id, secondsAgo(20), null);
    await verdict(matchId, b.id, secondsAgo(10), 'AC');
    await verdict(matchId, a.id, secondsAgo(20), 'AC', first);
    expect(await matchRow(matchId)).toMatchObject({ status: 'completed', winnerId: a.id });
  });

  it('timeout with nothing solved: completed, no winner, a draw for both', async () => {
    const { a, matchId } = await started();
    await verdict(matchId, a.id, secondsAgo(5), 'WA');
    await infra.db.db
      .update(matches)
      .set({ endsAt: sql`now() - interval '1 second'` })
      .where(eq(matches.id, matchId));
    await infra.matches.evaluate(matchId); // the match-timeout job
    expect(await matchRow(matchId)).toMatchObject({
      status: 'completed',
      winnerId: null,
      endReason: 'timeout',
    });
    const hist = (await call('GET', '/api/v1/matches/history', a)).json();
    expect(hist.items[0]).toMatchObject({ matchId, result: 'draw', endReason: 'timeout' });
  });

  it('the timeout job and an AC verdict racing: exactly one of them finishes the match', async () => {
    const { a, matchId } = await started();
    await infra.db.db
      .update(matches)
      .set({ endsAt: sql`now() - interval '1 second'` })
      .where(eq(matches.id, matchId));
    await Promise.all([infra.matches.evaluate(matchId), verdict(matchId, a.id, secondsAgo(5), 'AC')]);
    expect((await matchRow(matchId)).status).toBe('completed');
    expect((await eventsOf(matchId)).filter((t) => t === 'battle.match.completed.v1')).toHaveLength(1);
  });

  it('the deciding cap: no AC and verdicts still missing → aborted, no result', async () => {
    const { a, matchId } = await started();
    await verdict(matchId, a.id, secondsAgo(5), null);
    await infra.db.db
      .update(matches)
      .set({ endsAt: sql`now() - interval '1 second'` })
      .where(eq(matches.id, matchId));
    await infra.matches.evaluate(matchId);
    expect((await matchRow(matchId)).status).toBe('deciding');
    await infra.db.db
      .update(matches)
      .set({ decideDeadline: sql`now() - interval '1 second'` })
      .where(eq(matches.id, matchId));
    await worker.reconcile(); // the reconciler catches the passed deadline
    expect(await matchRow(matchId)).toMatchObject({ status: 'aborted', endReason: 'aborted' });
  });

  it('forfeit gives the win to the opponent; a second forfeit is refused', async () => {
    const { a, b, matchId } = await started();
    expect((await call('POST', `/api/v1/matches/${matchId}/forfeit`, a)).statusCode).toBe(204);
    expect(await matchRow(matchId)).toMatchObject({
      status: 'completed',
      winnerId: b.id,
      endReason: 'forfeit',
    });
    expect((await call('POST', `/api/v1/matches/${matchId}/forfeit`, b)).json().error.code).toBe(
      'MATCH_NOT_ACTIVE',
    );
    const outsider = await player();
    expect((await call('GET', `/api/v1/matches/${matchId}/state`, outsider)).statusCode).toBe(404);
  });

  it('end to end through Kafka: judge events build the read model and decide the winner', async () => {
    const { a, matchId } = await started();
    const submissionId = newId();
    const env = (type: string, data: object): EventEnvelope<unknown> => ({
      id: newId(),
      type,
      source: 'judge-service',
      occurredAt: new Date().toISOString(),
      aggregateId: submissionId,
      data,
    });
    const base = { submissionId, matchId, userId: a.id, problemId: PROBLEM_ID, mode: 'submit' };
    const submittedAt = secondsAgo(3).toISOString();
    const judged = env(judgeEvents.submissionJudgedV1.type, {
      ...base,
      verdict: 'AC',
      failedFile: null,
      failedCase: null,
      maxCpuMs: 5,
      maxMemKb: 900,
      fromCache: false,
      submittedAt,
      judgedAt: new Date().toISOString(),
    });
    await producer.send({
      topic: TOPICS.judge,
      messages: [
        {
          key: matchId,
          value: JSON.stringify(env(judgeEvents.submissionCreatedV1.type, { ...base, submittedAt })),
        },
        { key: matchId, value: JSON.stringify(judged) },
        { key: matchId, value: JSON.stringify(judged) }, // redelivery: the inbox makes it a no-op
      ],
    });
    await waitFor(async () => ((await matchRow(matchId)).status === 'completed' ? true : undefined), {
      what: 'match completed from Kafka',
      timeoutMs: 30_000,
    });
    expect((await matchRow(matchId)).winnerId).toBe(a.id);
    expect((await eventsOf(matchId)).filter((t) => t === 'battle.match.completed.v1')).toHaveLength(1);
  });
});
