import { generateSigningKey, JwtVerifier, TokenSigner } from '@cb/auth';
import {
  TOPICS,
  type CoinChargeRequest,
  type EventEnvelope,
  type InternalSubmission,
  type PublicProblem,
  type TutorFrame,
} from '@cb/contracts';
import { conflict } from '@cb/errors';
import { createProducer } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedpanda, waitFor, type Started } from '@cb/testing';
import { eq } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Upstreams } from '../clients.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { aiMatches, aiProblems, aiReviews, chunks, documents } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import { HashEmbedder } from '../llm/embedder.js';
import { defaultFake, FakeProvider } from '../llm/fake.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'ai-int', level: 'silent' });

let pg: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let signer: TokenSigner;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let producer: Producer;
const fake = new FakeProvider();

// ---------------- stubbed upstream services ----------------

const problems = new Map<string, PublicProblem>();
const subs: InternalSubmission[] = [];
const coins = new Map<string, number>();
const charges = new Map<string, CoinChargeRequest>();
const upstreams: Upstreams = {
  submission: async (id) => subs.find((s) => s.id === id) ?? null,
  submissions: async (q) =>
    subs
      .filter(
        (s) =>
          (!q.matchId || s.matchId === q.matchId) &&
          (!q.problemId || s.problemId === q.problemId) &&
          (!q.verdict || s.verdict === q.verdict),
      )
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, q.limit ?? 50),
  problem: async (slug) => problems.get(slug) ?? null,
  coins: async (u) => coins.get(u) ?? 400,
  charge: async (c) => {
    const key = `${c.matchId}:${c.userId}:${c.reason}`;
    if (charges.has(key)) return { charged: false, coins: coins.get(c.userId) ?? 400 };
    const have = coins.get(c.userId) ?? 400;
    if (have < c.amount) throw conflict('INSUFFICIENT_COINS', 'not enough');
    charges.set(key, c);
    coins.set(c.userId, have - c.amount);
    return { charged: true, coins: have - c.amount };
  },
};

beforeAll(async () => {
  [pg, rp] = await Promise.all([startPostgres(), startRedpanda()]);
  signer = await TokenSigner.create([await generateSigningKey('a')]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: 'ai-test-internal-secret-0123456789abcdef',
    AI_PROVIDER: 'fake',
    EMBEDDINGS: 'hash',
    AI_USER_DAILY_TOKENS: '20000',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger, {
    verifier: new JwtVerifier({ jwks: signer.publicJwks() }),
    upstreams,
    provider: fake,
    embedder: new HashEmbedder(),
  });
  worker = await startWorker(infra, { taskEveryMs: 200 });
  app = await buildApp(infra);
  producer = createProducer(infra.kafka);
  await producer.connect();
  await waitFor(async () => ((await infra.db.db.select().from(documents)).length >= 10 ? true : undefined), {
    what: 'notes indexed',
    timeoutMs: 30_000,
  });
}, 240_000);

afterAll(async () => {
  await producer?.disconnect();
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), rp?.stop()]);
});

// ---------------- helpers ----------------

const envelope = (type: string, key: string, data: object): EventEnvelope<unknown> => ({
  id: newId(),
  type,
  source: 'test',
  occurredAt: new Date().toISOString(),
  aggregateId: key,
  data,
});
const send = (topic: string, key: string, e: EventEnvelope<unknown>) =>
  producer.send({ topic, messages: [{ key, value: JSON.stringify(e) }] });

async function user() {
  const id = newId();
  const token = (await signer.signAccess({ userId: id, role: 'user', emailVerified: true }, 900)).token;
  return { id, token };
}
const admin = async () => {
  const id = newId();
  return {
    id,
    token: (await signer.signAccess({ userId: id, role: 'admin', emailVerified: true }, 900)).token,
  };
};
const call = (u: { token: string }, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${u.token}` },
    ...(payload ? { payload } : {}),
  });

async function publishProblem(tags = ['math', 'implementation']) {
  const id = newId();
  const slug = `pair-sums-${id.slice(-6)}`;
  problems.set(slug, {
    id,
    slug,
    title: 'Pair sums',
    statementMd: 'For each pair a b, print a + b. Values reach 10^12, so watch the integer type.',
    inputFormatMd: 'First t, then t lines with a and b.',
    outputFormatMd: 'One sum per line.',
    constraints: ['1 ≤ t ≤ 30000', '|a|, |b| ≤ 10^12'],
    examples: [{ input: '2\n1 2\n3 4', output: '3\n7' }],
    difficulty: 'Easy',
    tags,
    memoryLimitKb: 196608,
    timeLimitsMs: { cpp: 1000 },
    version: 2,
  });
  await send(
    TOPICS.problem,
    id,
    envelope('problem.published.v1', id, { problemId: id, slug, version: 2, difficulty: 'Easy', tags }),
  );
  await waitFor(async () => (await infra.readModel.problem(id)) ?? undefined, { what: 'problem read model' });
  return { id, slug };
}

async function startMatch(problemId: string, a: string, b: string) {
  const matchId = newId();
  await send(
    TOPICS.battle,
    matchId,
    envelope('battle.match.started.v1', matchId, {
      matchId,
      problemId,
      userIds: [a, b],
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 1_800_000).toISOString(),
      version: 1,
    }),
  );
  await waitFor(async () => (await infra.readModel.match(matchId)) ?? undefined, {
    what: 'match read model',
  });
  return matchId;
}

async function completeMatch(matchId: string, problemId: string, winner: string, loser: string) {
  await send(
    TOPICS.battle,
    matchId,
    envelope('battle.match.completed.v1', matchId, {
      matchId,
      problemId,
      userIds: [winner, loser],
      winnerId: winner,
      endReason: 'solved',
      results: { [winner]: 'win', [loser]: 'loss' },
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      endedAt: new Date().toISOString(),
      version: 3,
    }),
  );
  await waitFor(
    async () => ((await infra.readModel.match(matchId))?.status === 'completed' ? true : undefined),
    {
      what: 'match completed',
    },
  );
}

function addSubmission(s: Partial<InternalSubmission> & { userId: string; problemId: string; code: string }) {
  const full: InternalSubmission = {
    id: newId(),
    mode: 'submit',
    matchId: null,
    languageKey: 'cpp',
    status: 'done',
    verdict: 'AC',
    failedFile: null,
    failedCase: null,
    maxCpuMs: 12,
    maxMemKb: 3000,
    message: null,
    fromCache: false,
    custom: null,
    submittedAt: new Date().toISOString(),
    judgedAt: new Date().toISOString(),
    ...s,
  };
  subs.push(full);
  return full;
}

/** Parse an SSE body into frames. */
const frames = (body: string): TutorFrame[] =>
  body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as TutorFrame);

// ---------------- tests ----------------

describe('ai-service', () => {
  it('status and notes are public; the notes are indexed for the tutor', async () => {
    const s = await app.inject({ method: 'GET', url: '/api/v1/ai/status' });
    expect(s.json()).toMatchObject({ enabled: true, hintCosts: [10, 20, 30] });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/ai/notes' })).json().items;
    expect(list.map((n: { slug: string }) => n.slug)).toContain('prefix-sums');
    const note = (await app.inject({ method: 'GET', url: '/api/v1/ai/notes/prefix-sums' })).json();
    expect(note.markdown).toContain('pre[r+1] - pre[l]');
    const n = await infra.db.db.select().from(chunks);
    expect(n.length).toBeGreaterThan(20);
  });

  it('hints in a battle: in order, charged once per level, refused when unaffordable, free afterwards', async () => {
    const [a, b] = [await user(), await user()];
    const p = await publishProblem();
    const matchId = await startMatch(p.id, a.id, b.id);

    // level 2 before level 1
    const early = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 2, matchId });
    expect(early.statusCode).toBe(409);

    const h1 = await call(a, 'POST', '/api/v1/ai/hints', {
      problemId: p.id,
      level: 1,
      matchId,
      code: 'int a,b;',
    });
    expect(h1.statusCode, h1.body).toBe(200);
    expect(h1.json()).toMatchObject({ level: 1, charged: 10, coins: 390 });
    // asking again: same hint, no new charge, no new model call
    const callsBefore = fake.calls.length;
    const again = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 1, matchId });
    expect(again.json()).toMatchObject({ text: h1.json().text, charged: 0 });
    expect(fake.calls.length).toBe(callsBefore);

    // can't afford level 2: refused and not shown
    coins.set(a.id, 5);
    const poor = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 2, matchId });
    expect(poor.statusCode).toBe(409);
    expect(poor.json().error.code).toBe('INSUFFICIENT_COINS');
    expect((await call(a, 'GET', `/api/v1/ai/hints?problemId=${p.id}`)).json().items).toHaveLength(1);

    // the opponent can't use this match id for someone else's problem, an outsider gets nothing
    const outsider = await user();
    const no = await call(outsider, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 1 });
    expect(no.statusCode).toBe(403);

    // after the match: free
    await completeMatch(matchId, p.id, b.id, a.id);
    coins.set(a.id, 0);
    const h2 = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 2 });
    expect(h2.statusCode, h2.body).toBe(200);
    expect(h2.json()).toMatchObject({ level: 2, charged: 0 });
    expect([...charges.keys()].filter((k) => k.startsWith(matchId))).toEqual([`${matchId}:${a.id}:hint_1`]);
  });

  it('the leak guard: code in a hint is rejected, and a model-flagged hint is regenerated or refused', async () => {
    const [a, b] = [await user(), await user()];
    const p = await publishProblem();
    const matchId = await startMatch(p.id, a.id, b.id);
    await completeMatch(matchId, p.id, a.id, b.id);

    fake.setHandler((req) => {
      if (req.json?.name === 'leak_guard')
        return JSON.stringify({ revealsSolution: true, reason: 'full algorithm' });
      return '```cpp\nint main() { long long a, b; }\n```';
    });
    const r = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 1 });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('AI_UNAVAILABLE');

    // the first draft is flagged by the guard, the second passes
    let n = 0;
    fake.setHandler((req) => {
      if (req.json?.name === 'leak_guard') return JSON.stringify({ revealsSolution: n++ === 0, reason: 'x' });
      return 'Consider the largest value a sum can reach.';
    });
    const ok = await call(a, 'POST', '/api/v1/ai/hints', { problemId: p.id, level: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    fake.setHandler(defaultFake);
  });

  it('tutor: off during a match; afterwards streams an answer with citations; problems only for players', async () => {
    const [a, b, stranger] = [await user(), await user(), await user()];
    const p = await publishProblem(['math']);
    await waitFor(
      async () =>
        (await infra.db.db.select().from(documents).where(eq(documents.ref, p.id))).length ? true : undefined,
      { what: 'problem ingested' },
    );
    const matchId = await startMatch(p.id, a.id, b.id);
    const during = await call(a, 'POST', '/api/v1/ai/tutor', { question: 'How do prefix sums work?' });
    expect(during.statusCode).toBe(403);
    expect(during.json().error.code).toBe('AI_NOT_ALLOWED');

    await completeMatch(matchId, p.id, a.id, b.id);
    const res = await call(a, 'POST', '/api/v1/ai/tutor', { question: 'Pair sums: why overflow with int?' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const fs = frames(res.body);
    expect(fs[0]!.type).toBe('citations');
    expect(fs.filter((f) => f.type === 'delta').length).toBeGreaterThan(0);
    expect(fs.at(-1)).toEqual({ type: 'done' });
    const cited = (fs[0] as Extract<TutorFrame, { type: 'citations' }>).items;
    expect(cited.some((c) => c.kind === 'problem')).toBe(true);
    // the user's question is fenced as data in the prompt, never as instructions
    const last = fake.calls.at(-1)!;
    expect(last.messages.at(-1)!.content).toContain('<question>');

    // someone who hasn't played it never gets the statement as context (no spoilers)
    const s = await call(stranger, 'POST', '/api/v1/ai/tutor', {
      question: 'Pair sums: why overflow with int?',
    });
    const sc = (frames(s.body)[0] as Extract<TutorFrame, { type: 'citations' }>).items;
    expect(sc.every((c) => c.kind === 'note')).toBe(true);
  });

  it('tutor explains your own failed submission, not someone else’s', async () => {
    const [a, b] = [await user(), await user()];
    const p = await publishProblem();
    const sub = addSubmission({
      userId: a.id,
      problemId: p.id,
      verdict: 'WA',
      code: 'int a, b; cin >> a >> b;',
    });
    const ok = await call(a, 'POST', '/api/v1/ai/tutor', { question: 'Why WA?', submissionId: sub.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(fake.calls.at(-1)!.messages.at(-1)!.content).toContain('<user_code>');
    const not = await call(b, 'POST', '/api/v1/ai/tutor', { question: 'Why WA?', submissionId: sub.id });
    expect(not.statusCode).toBe(404);
  });

  it('coach: a review is written by the worker for a finished match; only its players can ask', async () => {
    const [a, b, outsider] = [await user(), await user(), await user()];
    const p = await publishProblem();
    const matchId = await startMatch(p.id, a.id, b.id);
    addSubmission({ userId: a.id, problemId: p.id, matchId, verdict: 'WA', code: 'int s = a + b;' });
    addSubmission({ userId: b.id, problemId: p.id, matchId, verdict: 'AC', code: 'long long s = a + b;' });

    const running = await call(a, 'POST', '/api/v1/ai/reviews', { matchId });
    expect(running.statusCode).toBe(403);
    await completeMatch(matchId, p.id, b.id, a.id);
    expect((await call(outsider, 'POST', '/api/v1/ai/reviews', { matchId })).statusCode).toBe(404);

    const r = await call(a, 'POST', '/api/v1/ai/reviews', { matchId });
    expect(r.statusCode, r.body).toBe(202);
    const ready = await waitFor(
      async () => {
        const g = (await call(a, 'GET', `/api/v1/ai/reviews/${matchId}`)).json();
        return g.status === 'ready' ? g : undefined;
      },
      { what: 'review ready', timeoutMs: 15_000 },
    );
    expect(ready.review.issues[0].title).toContain('overflow');
    // the opponent's code was compared, and asking again doesn't call the model again
    const reviewCall = fake.calls.find((c) => c.json?.name === 'match_review')!;
    expect(reviewCall.messages.at(-1)!.content).toContain('long long s = a + b;');
    const n = fake.calls.length;
    expect((await call(a, 'POST', '/api/v1/ai/reviews', { matchId })).json().status).toBe('ready');
    expect(fake.calls.length).toBe(n);
    const [row] = await infra.db.db.select().from(aiReviews).where(eq(aiReviews.matchId, matchId));
    expect(row!.promptVersion).toBe('review-v1');
  });

  it('anti-cheat: a disguised copy of the opponent’s code is flagged for an admin; honest code is not', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const p = await publishProblem();
    const original = `#include <bits/stdc++.h>
using namespace std;
int main() { int n, q; cin >> n >> q; vector<long long> pre(n + 1, 0);
  for (int i = 0; i < n; i++) { long long x; cin >> x; pre[i + 1] = pre[i] + x; }
  while (q--) { int l, r; cin >> l >> r; long long best = pre[r] - pre[l - 1]; if (best < 0) best = 0;
    cout << best << "\\n"; } return 0; }`;
    const copy = original.replace(/pre/g, 'acc').replace(/best/g, 'res').replace(/\bq\b/g, 'qs');
    const m1 = await startMatch(p.id, a.id, b.id);
    addSubmission({ userId: a.id, problemId: p.id, matchId: m1, code: original });
    addSubmission({ userId: b.id, problemId: p.id, matchId: m1, code: copy });
    await completeMatch(m1, p.id, a.id, b.id);
    const honest = await startMatch(p.id, c.id, d.id);
    addSubmission({
      userId: c.id,
      problemId: p.id,
      matchId: honest,
      code: 'print(sum(map(int, input().split())))',
    });
    await completeMatch(honest, p.id, c.id, d.id);

    // the checks run a minute after the match: run them now
    await infra.integrity.check(m1);
    await infra.integrity.check(honest);
    const boss = await admin();
    const flags = (await call(boss, 'GET', '/api/v1/admin/ai/flags?status=open')).json().items;
    const mine = flags.filter((f: { matchId: string }) => f.matchId === m1 || f.matchId === honest);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((f: { matchId: string }) => f.matchId === m1)).toBe(true);
    expect(mine[0].similarity).toBeGreaterThan(0.8);
    const reviewed = await call(boss, 'POST', `/api/v1/admin/ai/flags/${mine[0].id}/review`, {
      status: 'cleared',
      note: 'template code',
    });
    expect(reviewed.json()).toMatchObject({ status: 'cleared', note: 'template code' });
    expect((await call(a, 'GET', '/api/v1/admin/ai/flags')).statusCode).toBe(403);
  });

  it('recommendations come from your own verdicts per topic', async () => {
    const u = await user();
    const starter = (await call(u, 'GET', '/api/v1/ai/recommendations')).json();
    expect(starter.basis).toBe('starter');
    const p1 = await publishProblem(['math', 'overflow']);
    const p2 = await publishProblem(['prefix-sums']);
    const judged = (problemId: string, verdict: string) => {
      const submissionId = newId();
      return send(
        TOPICS.judge,
        submissionId,
        envelope('judge.submission.judged.v1', submissionId, {
          submissionId,
          matchId: null,
          userId: u.id,
          problemId,
          mode: 'submit',
          verdict,
          failedFile: null,
          failedCase: null,
          maxCpuMs: null,
          maxMemKb: null,
          fromCache: false,
          submittedAt: new Date().toISOString(),
          judgedAt: new Date().toISOString(),
        }),
      );
    };
    await judged(p1.id, 'WA');
    await judged(p1.id, 'WA');
    await judged(p2.id, 'AC');
    const rec = await waitFor(
      async () => {
        const r = (await call(u, 'GET', '/api/v1/ai/recommendations')).json();
        return r.basis === 'history' ? r : undefined;
      },
      { what: 'history-based recommendations' },
    );
    expect(rec.weak[0]).toMatchObject({ failed: 1, commonVerdict: 'WA' });
    expect(['math', 'overflow']).toContain(rec.weak[0].tag);
    expect(rec.weak[0].notes.length).toBeGreaterThan(0);
    expect(rec.strong).toContain('prefix-sums');
  });

  it('a player’s daily allowance runs out with 429; admins see usage per model and feature', async () => {
    const [a, b] = [await user(), await user()];
    const p = await publishProblem();
    const m = await startMatch(p.id, a.id, b.id);
    await completeMatch(m, p.id, a.id, b.id);
    let last = 200;
    for (let i = 0; i < 30 && last === 200; i++) {
      last = (await call(a, 'POST', '/api/v1/ai/tutor', { question: `Explain binary search ${i} in depth` }))
        .statusCode;
    }
    expect(last).toBe(429);
    const usage = (await call(await admin(), 'GET', '/api/v1/admin/ai/usage')).json();
    expect(usage.models.map((x: { model: string }) => x.model)).toEqual([
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ]);
    expect(usage.byFeature.map((x: { feature: string }) => x.feature)).toEqual(
      expect.arrayContaining(['tutor', 'hint', 'review']),
    );
  });

  it('read models: problems and matches arrive from events exactly once', async () => {
    const p = await publishProblem();
    const rows = await infra.db.db.select().from(aiProblems).where(eq(aiProblems.problemId, p.id));
    expect(rows).toHaveLength(1);
    const ms = await infra.db.db.select().from(aiMatches);
    expect(ms.length).toBeGreaterThan(3);
  });
});
