import { generateSigningKey, JwtVerifier, signInternalToken, TokenSigner } from '@cb/auth';
import { LANGUAGE_KEYS, type AdminProblem, type CreateProblemBody, type JudgeSpec } from '@cb/contracts';
import { ensureTopics, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import type { CalibrationRequest, CalibrationResult } from '@cb/contracts';
import type { JudgeClient } from '../modules/calibration/judge-client.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { blobs, userProblemSeen } from '../db/schema.js';
import { createInfra, SERVICE_TOPICS, type Infra } from '../infra.js';

const logger = createLogger({ service: 'problem-int', level: 'silent' });
const SECRET = 'problem-test-internal-secret-0123456789';
let pg: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let redis: Started<{ url: string }>;
let worker: WorkerHandle;
let infra: Infra;
let app: HttpServer;
let signer: TokenSigner;
let setter: string;
let player: string;
let svcToken: string;

beforeAll(async () => {
  [pg, rp, redis] = await Promise.all([startPostgres(), startRedpanda(), startRedis()]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    REDIS_URL: redis.value.url,
    INTERNAL_SERVICE_SECRET: SECRET,
    SELF_URL: 'http://problem-service:4004',
  });
  await migrate(env.DATABASE_URL);
  signer = await TokenSigner.create([await generateSigningKey('t')]);
  infra = await createInfra(env, logger, {
    verifier: new JwtVerifier({ jwks: signer.publicJwks() }),
    judge: stubJudge,
    calibrationPollMs: 50,
  });
  worker = await startWorker(infra);
  await ensureTopics(infra.kafka, SERVICE_TOPICS);
  app = await buildApp(infra);
  setter = (await signer.signAccess({ userId: newId(), role: 'problem_setter', emailVerified: true }, 900))
    .token;
  player = (await signer.signAccess({ userId: newId(), role: 'user', emailVerified: true }, 900)).token;
  svcToken = await signInternalToken(SECRET, 'battle-service');
});

afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), rp?.stop(), redis?.stop()]);
});

// ---------------- a scripted judge for calibration ----------------

/**
 * Reference code is a script: "times:10,120,450" (per-file CPU ms, all AC), "TLE" for a file that
 * times out, "wrong:2" to fail file 2. Each run "finishes" on its second poll, like a real judge.
 */
const calls: CalibrationRequest[] = [];
const judgeRuns = new Map<string, { req: CalibrationRequest; polls: number }>();
const stubJudge: JudgeClient = {
  async startCalibration(req) {
    calls.push(req);
    const existing = [...judgeRuns.entries()].find(([, r]) => r.req.requestKey === req.requestKey);
    const id = existing?.[0] ?? newId();
    if (!existing) judgeRuns.set(id, { req, polls: 0 });
    return this.calibration(id);
  },
  async calibration(id): Promise<CalibrationResult> {
    const r = judgeRuns.get(id)!;
    const spec = await infra.problems.judgeSpec(r.req.problemId);
    const done = r.polls++ > 0;
    const times = /times:([\w,]+)/.exec(r.req.code)?.[1]?.split(',') ?? [];
    const wrong = Number(/wrong:(\d+)/.exec(r.req.code)?.[1] ?? 0);
    return {
      id,
      status: done ? 'done' : 'running',
      problemVersion: spec.version,
      cpuLimitMs: Math.min(r.req.cpuLimitMs, 15000),
      files: done
        ? spec.files.map((f, i) => {
            const t = times[i] ?? '10';
            return {
              ordinal: f.ordinal,
              kind: f.kind,
              verdict:
                t === 'TLE' ? ('TLE' as const) : f.ordinal === wrong ? ('WA' as const) : ('AC' as const),
              cpuMs: t === 'TLE' ? 15000 : Number(t),
              memKb: 1000,
              failedCase: f.ordinal === wrong ? 1 : null,
            };
          })
        : [],
    };
  },
};

// ---------------- helpers ----------------

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, token?: string, body?: object) =>
  app.inject({
    method,
    url,
    ...(body ? { payload: body } : {}),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const code = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

let seq = 0;
const draft = (over: Partial<CreateProblemBody> = {}): CreateProblemBody =>
  ({
    slug: `sum-pairs-${++seq}-${Date.now().toString(36)}`,
    title: 'Sum the pairs',
    statementMd: 'Print a+b for every pair.',
    inputFormatMd: 'First t, then t lines with a and b.',
    outputFormatMd: 'One line per case.',
    constraints: ['1 ≤ t ≤ 10^5'],
    examples: [{ input: '2\n1 2\n3 4', output: '3\n7' }],
    difficulty: 'Easy',
    tags: ['math'],
    ...over,
  }) as CreateProblemBody;

const PACKS = {
  1: { kind: 'sample', input: '2\n1 2\n3 4\n', output: '3\n7\n' },
  2: { kind: 'small', input: '3\n0 0\n-1 1\n5 5\n', output: '0\n0\n10\n' },
  3: { kind: 'large', input: '2\n1000000 1000000\n7 8\n', output: '2000000\n15\n' },
} as const;

async function create(over: Partial<CreateProblemBody> = {}): Promise<AdminProblem> {
  const r = await call('POST', '/api/v1/admin/problems', setter, draft(over));
  expect(r.statusCode).toBe(201);
  return r.json() as AdminProblem;
}

/** Files + references + calibration + publish. */
async function published(over: Partial<CreateProblemBody> = {}): Promise<AdminProblem> {
  const p = await create(over);
  for (const [ordinal, pack] of Object.entries(PACKS)) {
    expect(
      (await call('PUT', `/api/v1/admin/problems/${p.id}/test-files/${ordinal}`, setter, pack)).statusCode,
    ).toBe(200);
  }
  await call('POST', `/api/v1/admin/problems/${p.id}/reference-solutions`, setter, {
    languageKey: 'cpp',
    expectedVerdict: 'AC',
    code: 'int main(){}',
  });
  await call('POST', `/api/v1/admin/problems/${p.id}/reference-solutions`, setter, {
    languageKey: 'python',
    expectedVerdict: 'TLE',
    code: 'while True: pass',
  });
  const current = (await call('GET', `/api/v1/admin/problems/${p.id}`, setter)).json() as AdminProblem;
  await infra.problems.applyCalibration(
    p.id,
    current.version,
    [1, 2, 3].flatMap((ordinal) =>
      LANGUAGE_KEYS.map((languageKey, i) => ({
        ordinal,
        languageKey,
        cpuLimitMs: 1000 + ordinal * 100 + i * 500,
      })),
    ),
  );
  const r = await call('POST', `/api/v1/admin/problems/${p.id}/publish`, setter);
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json() as AdminProblem;
}

const select = (matchId: string, userIds: string[], difficulty?: string) =>
  app.inject({
    method: 'POST',
    url: '/internal/selections',
    payload: { matchId, userIds, ...(difficulty ? { difficulty } : {}) },
    headers: { authorization: `Bearer ${svcToken}` },
  });

// ---------------- tests ----------------

describe('admin authoring', () => {
  it('needs the problem_setter role', async () => {
    expect((await call('POST', '/api/v1/admin/problems', undefined, draft())).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/admin/problems', player, draft())).statusCode).toBe(403);
    const admin = (await signer.signAccess({ userId: newId(), role: 'admin', emailVerified: true }, 900))
      .token;
    expect((await call('GET', '/api/v1/admin/problems', admin)).statusCode).toBe(200);
  });

  it('creates drafts; validates slug uniqueness and the float checker', async () => {
    const p = await create();
    expect(p).toMatchObject({
      status: 'draft',
      version: 1,
      checkerType: 'tokens',
      testFiles: [],
      calibratedAt: null,
    });
    expect(code(await call('POST', '/api/v1/admin/problems', setter, draft({ slug: p.slug })))).toBe(
      'SLUG_TAKEN',
    );
    expect(
      (await call('POST', '/api/v1/admin/problems', setter, draft({ checkerType: 'float' }))).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/api/v1/admin/problems', setter, draft({ slug: 'Bad Slug' }))).statusCode,
    ).toBe(400);
  });

  it('validates packs with judge-core and stores content-addressed blobs', async () => {
    const p = await create();
    const bad = await call('PUT', `/api/v1/admin/problems/${p.id}/test-files/1`, setter, {
      kind: 'sample',
      input: '3\n1 2\n',
      output: '3\n',
    });
    expect([bad.statusCode, code(bad)]).toEqual([422, 'TEST_PACK_INVALID']);
    expect(bad.json().error.message).toBe('Expected output has 1 lines but the cases need 3');

    const ok = (
      await call('PUT', `/api/v1/admin/problems/${p.id}/test-files/1`, setter, PACKS[1])
    ).json() as AdminProblem;
    expect(ok.testFiles).toMatchObject([{ ordinal: 1, kind: 'sample', caseCount: 2 }]);
    expect(ok.version).toBe(2);
    const before = (await infra.db.db.select().from(blobs)).length;
    // same content in another problem: no new blob rows
    const q = await create();
    await call('PUT', `/api/v1/admin/problems/${q.id}/test-files/1`, setter, PACKS[1]);
    expect((await infra.db.db.select().from(blobs)).length).toBe(before);
    expect(
      (await call('PUT', `/api/v1/admin/problems/${p.id}/test-files/5`, setter, PACKS[1])).statusCode,
    ).toBe(400);
  });

  it('refuses to publish until everything is ready, listing all blockers', async () => {
    const p = await create();
    const r = await call('POST', `/api/v1/admin/problems/${p.id}/publish`, setter);
    expect([r.statusCode, code(r)]).toEqual([422, 'PROBLEM_NOT_PUBLISHABLE']);
    expect((r.json().error.details as { code: string }[]).map((b) => b.code)).toEqual([
      'NO_SAMPLE_FILE',
      'NO_SMALL_FILE',
      'NO_LARGE_FILE',
      'NO_CPP_AC_REFERENCE',
      'NO_TLE_REFERENCE',
      'NOT_CALIBRATED',
    ]);
  });

  it('publishes after calibration (version bump + event), and calibration of a stale version is refused', async () => {
    const p = await published();
    expect(p).toMatchObject({ status: 'published' });
    expect(p.limits).toHaveLength(12);
    const evts = await infra.db.db.select().from(outbox).where(eq(outbox.key, p.id));
    expect(evts.map((e) => e.type)).toContain('problem.published.v1');
    await expect(infra.problems.applyCalibration(p.id, p.version - 1, [])).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('statement edits keep it published; limit or test edits unpublish and void calibration', async () => {
    const p = await published();
    const s = (
      await call('PATCH', `/api/v1/admin/problems/${p.id}`, setter, { title: 'Sum the pairs, again' })
    ).json();
    expect(s).toMatchObject({ status: 'published', version: p.version, title: 'Sum the pairs, again' });

    const m = (
      await call('PATCH', `/api/v1/admin/problems/${p.id}`, setter, { memoryLimitKb: 65536 })
    ).json() as AdminProblem;
    expect(m).toMatchObject({ status: 'draft', version: p.version + 1, calibratedAt: null, limits: [] });

    const q = await published();
    const t = (
      await call('DELETE', `/api/v1/admin/problems/${q.id}/test-files/3`, setter)
    ).json() as AdminProblem;
    expect(t).toMatchObject({ status: 'draft', version: q.version + 1, calibratedAt: null });
  });
});

describe('public view', () => {
  it('serves published problems only, with per-language limits and no test data', async () => {
    const p = await published();
    const r = await call('GET', `/api/v1/problems/${p.slug}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.timeLimitsMs).toEqual({ cpp: 1300, java: 1800, python: 2300, javascript: 2800 });
    expect(JSON.stringify(body)).not.toContain('1000000 1000000'); // hidden large test
    expect(body).not.toHaveProperty('testFiles');
    const d = await create();
    expect((await call('GET', `/api/v1/problems/${d.slug}`)).statusCode).toBe(404);
  });
});

describe('internal APIs', () => {
  it('judge-spec gives checker, limits and blob URLs; blobs need a service token', async () => {
    const p = await published();
    expect((await call('GET', `/internal/problems/${p.id}/judge-spec`, player)).statusCode).toBe(401);
    const spec = (await call('GET', `/internal/problems/${p.id}/judge-spec`, svcToken)).json() as JudgeSpec;
    expect(spec).toMatchObject({
      problemId: p.id,
      version: p.version,
      checker: { type: 'tokens', eps: null },
    });
    expect(spec.files.map((f) => [f.kind, f.caseCount])).toEqual([
      ['sample', 2],
      ['small', 3],
      ['large', 2],
    ]);
    expect(spec.files[2]!.cpuLimitMs).toEqual({ cpp: 1300, java: 1800, python: 2300, javascript: 2800 });
    const url = new URL(spec.files[2]!.inputUrl);
    expect(url.origin).toBe('http://problem-service:4004');
    const blob = await call('GET', url.pathname, svcToken);
    expect(blob.body).toBe(PACKS[3].input);
    expect((await call('GET', url.pathname)).statusCode).toBe(401);
  });

  it('selection is idempotent per match, marks both players, and avoids seen problems', async () => {
    const hard = await published({ difficulty: 'Hard', slug: `only-hard-${Date.now().toString(36)}` });
    const [a, b] = [newId(), newId()];
    const matchId = newId();

    const results = await Promise.all(Array.from({ length: 5 }, () => select(matchId, [a, b], 'Hard')));
    const picked = new Set(results.map((r) => r.json().problemId));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(picked).toEqual(new Set([hard.id]));

    const seen = await infra.db.db
      .select()
      .from(userProblemSeen)
      .where(eq(userProblemSeen.problemId, hard.id));
    expect(seen.map((s) => s.userId).sort()).toEqual([a, b].sort());

    // the only Hard problem is now seen by a: a new match with a can't get it
    const none = await select(newId(), [a, newId()], 'Hard');
    expect([none.statusCode, code(none)]).toEqual([409, 'NO_UNSEEN_PROBLEM']);
    // but replaying the original match still returns it
    expect((await select(matchId, [a, b], 'Hard')).json().problemId).toBe(hard.id);
  });

  it('archived problems are never selected', async () => {
    const p = await published({ difficulty: 'Medium', slug: `archived-${Date.now().toString(36)}` });
    await call('POST', `/api/v1/admin/problems/${p.id}/archive`, setter);
    const r = await select(newId(), [newId()], 'Medium');
    expect(r.statusCode === 409 || r.json().problemId !== p.id).toBe(true);
  });

  it('relays problem events to Kafka', async () => {
    await waitFor(
      async () => (await infra.db.db.select().from(outbox).where(isNull(outbox.publishedAt))).length === 0,
      { what: 'events published', timeoutMs: 30_000 },
    );
    const types = new Set((await infra.db.db.select().from(outbox).where(and())).map((e) => e.type));
    expect(types).toEqual(new Set(['problem.published.v1', 'problem.updated.v1']));
  });
});

describe('calibration', () => {
  async function ready(
    refs: { languageKey: string; expectedVerdict: string; code: string }[],
  ): Promise<AdminProblem> {
    const p = await create();
    for (const [ordinal, pack] of Object.entries(PACKS)) {
      await call('PUT', `/api/v1/admin/problems/${p.id}/test-files/${ordinal}`, setter, pack);
    }
    for (const ref of refs)
      await call('POST', `/api/v1/admin/problems/${p.id}/reference-solutions`, setter, ref);
    return (await call('GET', `/api/v1/admin/problems/${p.id}`, setter)).json() as AdminProblem;
  }
  const finished = (id: string) =>
    waitFor(
      async () => {
        const p = (await call('GET', `/api/v1/admin/problems/${id}`, setter)).json() as AdminProblem;
        return p.calibration && ['passed', 'failed'].includes(p.calibration.status) ? p : undefined;
      },
      { what: 'calibration', timeoutMs: 30_000 },
    );

  it('runs every reference on every file, sets limits, and then the problem publishes', async () => {
    const p = await ready([
      { languageKey: 'cpp', expectedVerdict: 'AC', code: '// times:10,120,450' },
      { languageKey: 'python', expectedVerdict: 'AC', code: '# times:50,200,900' },
      { languageKey: 'cpp', expectedVerdict: 'TLE', code: '// times:10,300,TLE' },
    ]);
    const r = await call('POST', `/api/v1/admin/problems/${p.id}/calibrate`, setter);
    expect([r.statusCode, r.json().status]).toEqual([202, 'pending']);
    // asking again while it runs returns the same calibration
    expect((await call('POST', `/api/v1/admin/problems/${p.id}/calibrate`, setter)).json().id).toBe(
      r.json().id,
    );

    const done = await finished(p.id);
    expect(done.calibration).toMatchObject({ status: 'passed', problems: [] });
    expect(done.calibration!.runs).toHaveLength(9);
    expect(done.calibratedAt).not.toBeNull();
    const lim = (lang: string, o: number) =>
      done.limits.find((l) => l.languageKey === lang && l.ordinal === o)?.cpuLimitMs;
    expect([lim('cpp', 3), lim('python', 3), lim('java', 3)]).toEqual([1400, 2700, 2700]);
    expect(calls.filter((c) => c.problemId === p.id).map((c) => c.cpuLimitMs)).toEqual([15000, 15000, 15000]);

    const pub = await call('POST', `/api/v1/admin/problems/${p.id}/publish`, setter);
    expect([pub.statusCode, pub.json().status]).toEqual([200, 'published']);
  });

  it('fails with readable problems when references misbehave, and publishing stays blocked', async () => {
    const p = await ready([
      { languageKey: 'cpp', expectedVerdict: 'AC', code: '// times:10,120,450' },
      { languageKey: 'cpp', expectedVerdict: 'AC', code: '// a second, wrong one: wrong:2' },
      { languageKey: 'cpp', expectedVerdict: 'TLE', code: '// times:10,20,30' },
    ]);
    await call('POST', `/api/v1/admin/problems/${p.id}/calibrate`, setter);
    const done = await finished(p.id);
    expect(done.calibration!.status).toBe('failed');
    expect(done.calibration!.problems.map((x) => x.code).sort()).toEqual([
      'REFERENCE_FAILED',
      'TLE_REFERENCE_TOO_FAST',
    ]);
    expect(done.calibratedAt).toBeNull();
    expect((await call('POST', `/api/v1/admin/problems/${p.id}/publish`, setter)).json().error.code).toBe(
      'PROBLEM_NOT_PUBLISHABLE',
    );
  });

  it('needs test files and a C++ AC reference before it starts', async () => {
    const p = await create();
    const r = await call('POST', `/api/v1/admin/problems/${p.id}/calibrate`, setter);
    expect([r.statusCode, (r.json().error.details as { code: string }[]).map((d) => d.code)]).toEqual([
      422,
      ['NO_FILES', 'NO_CPP_AC_REFERENCE'],
    ]);
  });
});
