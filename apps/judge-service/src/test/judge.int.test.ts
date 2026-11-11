import { generateSigningKey, JwtVerifier, signInternalToken, TokenSigner } from '@cb/auth';
import type { JudgeSpec, SubmissionView } from '@cb/contracts';
import { outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { RateLimiter } from '@cb/rate-limit';
import { createRedis, SafeRedis } from '@cb/redis';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { judgeBudgetDaily, judgeDriftChecks, judgeRuns } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import type { ProblemSource } from '../problems/problem-source.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'judge-int', level: 'silent' });
const SECRET = 'judge-test-internal-secret-0123456789ab';

// ---------------- a problem in memory: "print a+b for every pair" ----------------

const PROBLEM_ID = '0193f000-0000-7000-8000-000000000001';
const DRAFT_ID = '0193f000-0000-7000-8000-000000000002';
const pairs = (n: number, seed = 1) =>
  Array.from({ length: n }, (_, i) => [
    ((i * 7919 + seed) % 100000) - 50000,
    ((i * 104729 + seed) % 100000) - 50000,
  ]);
const pack = (ps: number[][]) => ({
  input: `${ps.length}\n${ps.map(([a, b]) => `${a} ${b}`).join('\n')}\n`,
  output: `${ps.map(([a, b]) => a! + b!).join('\n')}\n`,
});
const FILES = {
  1: pack([
    [1, 2],
    [3, 4],
  ]),
  2: pack(pairs(3, 5)),
  3: pack(pairs(2000, 9)),
}; // large ≈ 25 KB
const blobs = new Map<string, string>();
const fileSpec = (ordinal: 1 | 2 | 3, kind: 'sample' | 'small' | 'large') => {
  blobs.set(`mem://in/${ordinal}`, FILES[ordinal].input);
  blobs.set(`mem://out/${ordinal}`, FILES[ordinal].output);
  const caseCount = Number(FILES[ordinal].input.split('\n', 1)[0]);
  return {
    ordinal,
    kind,
    caseCount,
    outputCaseLineCounts: null,
    sha256: `sha-${ordinal}`,
    inputUrl: `mem://in/${ordinal}`,
    outputUrl: `mem://out/${ordinal}`,
    cpuLimitMs: { cpp: 1000, java: 2000, python: 1000, javascript: 1500 },
  };
};
const SPEC: JudgeSpec = {
  problemId: PROBLEM_ID,
  version: 3,
  status: 'published',
  checker: { type: 'tokens', eps: null },
  memoryLimitKb: 196_608,
  outputLimitKb: 1024,
  files: [fileSpec(1, 'sample'), fileSpec(2, 'small'), fileSpec(3, 'large')],
};
const problems: ProblemSource = {
  spec: async (id) =>
    id === PROBLEM_ID
      ? SPEC
      : id === DRAFT_ID
        ? { ...SPEC, problemId: DRAFT_ID, status: 'draft' }
        : undefined,
  text: async (url) => blobs.get(url) ?? '',
};

// ---------------- environment ----------------

let pgC: Started<{ url: string }>;
let redisC: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let fake: ChildProcess;
let fakeUrl: string;
let signer: TokenSigner;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function startFake(): Promise<void> {
  const port = await freePort();
  const entry = fileURLToPath(new URL('../../../fake-judge0/dist/index.js', import.meta.url));
  fake = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'silent' },
    stdio: 'ignore',
  });
  fakeUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${fakeUrl}/config_info`).catch(() => null))?.ok, {
    what: 'fake-judge0',
    timeoutMs: 20_000,
  });
}

const fakeStats = async () =>
  (await (await fetch(`${fakeUrl}/__fake/stats`)).json()) as { created: number; callbacks: number };

/** A database per mode inside the one Postgres container. */
async function database(name: string): Promise<string> {
  const c = new pg.Client({ connectionString: pgC.value.url });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const u = new URL(pgC.value.url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Tests flip these to simulate the BullMQ Redis being down (plan §18.1). */
const queueDown = { poll: false, callback: false };

interface Stack {
  infra: Infra;
  app: HttpServer;
  worker: WorkerHandle;
  url?: string;
}

async function stack(
  mode: 'poll' | 'callback',
  redisDb: number,
  extraEnv: Record<string, string> = {},
): Promise<Stack> {
  const port = mode === 'callback' ? await freePort() : 0;
  const redisUrl = new URL(redisC.value.url);
  redisUrl.pathname = `/${redisDb}`;
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: await database(`judge_${mode}`),
    REDIS_URL: redisUrl.toString(),
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: SECRET,
    JUDGE0_URL: fakeUrl,
    JUDGE0_MODE: mode,
    JUDGE0_DAILY_BUDGET: '500',
    MATCH_RESERVE_CALLS: '40',
    MAX_SUBMITS_PER_MATCH: '3',
    ...(mode === 'callback'
      ? { JUDGE0_CALLBACK_BASE_URL: `http://127.0.0.1:${port}`, JUDGE0_CALLBACK_SECRET: 'c'.repeat(40) }
      : {}),
    ...extraEnv,
  });
  await migrate(env.DATABASE_URL);
  // per-user submit/run limits are tested elsewhere; here they would only slow the suite down
  const safe = new SafeRedis(
    createRedis({ url: env.REDIS_URL, role: 'cache', logger, name: 'judge-test' }),
    logger,
  );
  const unlimited = (prefix: string) =>
    new RateLimiter({ redis: safe, prefix, capacity: 1e6, refillPerSec: 1e6 });
  const infra = await createInfra(env, logger, {
    verifier: new JwtVerifier({ jwks: signer.publicJwks() }),
    problems,
    limits: { submit: unlimited(`t-submit-${mode}`), run: unlimited(`t-run-${mode}`) },
    queueHealthy: () => !queueDown[mode],
  });
  const worker = await startWorker(infra);
  const app = await buildApp(infra);
  if (mode === 'callback') await app.listen({ host: '127.0.0.1', port });
  return { infra, app, worker, ...(mode === 'callback' ? { url: `http://127.0.0.1:${port}` } : {}) };
}

let poll: Stack;
let cb: Stack;

beforeAll(async () => {
  [pgC, redisC, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  await startFake();
  signer = await TokenSigner.create([await generateSigningKey('j')]);
  poll = await stack('poll', 1);
  cb = await stack('callback', 2);
}, 240_000);

afterAll(async () => {
  for (const s of [poll, cb]) {
    await s?.worker.stop();
    await s?.app.close();
    await s?.infra.close();
  }
  fake?.kill();
  await Promise.all([pgC?.stop(), redisC?.stop(), rp?.stop()]);
});

// ---------------- helpers ----------------

const player = async (role: 'user' | 'problem_setter' | 'admin' = 'user', ev = true) =>
  (await signer.signAccess({ userId: newId(), role, emailVerified: ev }, 900)).token;

async function submit(
  s: Stack,
  token: string,
  code: string,
  over: Partial<{
    mode: 'submit' | 'run';
    problemId: string;
    matchId: string;
    customInput: string;
    languageKey: string;
  }> = {},
) {
  return s.app.inject({
    method: 'POST',
    url: '/api/v1/submissions',
    payload: { mode: 'submit', problemId: PROBLEM_ID, languageKey: 'python', code, ...over },
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
  });
}

async function result(s: Stack, token: string, id: string): Promise<SubmissionView> {
  return waitFor(
    async () => {
      const v = (
        await s.app.inject({
          method: 'GET',
          url: `/api/v1/submissions/${id}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json() as SubmissionView;
      return v.status === 'done' ? v : undefined;
    },
    { what: `submission ${id}`, timeoutMs: 45_000, intervalMs: 200 },
  );
}

async function judge(s: Stack, code: string, over: Parameters<typeof submit>[3] = {}) {
  const token = await player();
  const res = await submit(s, token, code, over);
  expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
  return result(s, token, res.json().submissionId);
}

const runsOf = (s: Stack, id: string) =>
  s.infra.db.db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, id));
let uniq = 0;
/** Fake directives in a Python comment; a unique suffix keeps the verdict cache out of the way. */
const usedToday = async (s: Stack) => (await s.infra.submissions.capacity()).used;

/** Wait until earlier tests' submissions are done, so budget deltas belong to this test only. */
const quiet = (s: Stack) =>
  waitFor(
    async () => {
      const { rows } = await s.infra.db.pool.query<{ n: number }>(
        "select count(*)::int as n from submissions where status in ('queued','running')",
      );
      return rows[0]!.n === 0 ? true : undefined;
    },
    { what: 'idle judge', timeoutMs: 60_000 },
  );

const code = (directives: string) => `# @fake ${directives}\nprint("solution ${++uniq}")\n`;

// ---------------- tests ----------------

describe('verdicts (poll mode)', () => {
  it('AC: all three files, two stages, max time/memory reported', async () => {
    const v = await judge(poll, code('program=sum-cases memory=3000'));
    expect(v).toMatchObject({ verdict: 'AC', failedFile: null, maxMemKb: 3000, fromCache: false });
    const runs = await runsOf(poll, v.id);
    expect(runs.map((r) => [r.stage, r.fileOrdinal]).sort()).toEqual([
      [1, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('WA reports the file and the case; later stages never run (fail fast)', async () => {
    const v = await judge(poll, code('program=sum-cases wrongCase=3'));
    expect(v).toMatchObject({ verdict: 'WA', failedFile: { ordinal: 2, kind: 'small' }, failedCase: 3 });
    expect((await runsOf(poll, v.id)).some((r) => r.fileOrdinal === 3)).toBe(false);
  });

  it('TLE on the large pack only (stage 2)', async () => {
    const v = await judge(poll, code('program=sum-cases timePerKb=0.5'));
    expect(v).toMatchObject({ verdict: 'TLE', failedFile: { ordinal: 3, kind: 'large' } });
    expect((await runsOf(poll, v.id)).filter((r) => r.fileOrdinal === 3)).toHaveLength(1);
  });

  it('near-miss TLE gets exactly one rerun', async () => {
    // ~25 KB large input × 0.044 s/KB ≈ 1.1 s against a 1 s limit
    const v = await judge(poll, code('program=sum-cases timePerKb=0.044'));
    expect(v).toMatchObject({ verdict: 'TLE', failedFile: { ordinal: 3 } });
    expect(
      (await runsOf(poll, v.id))
        .filter((r) => r.fileOrdinal === 3)
        .map((r) => r.attempt)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('CE stops everything and returns the compiler output', async () => {
    const v = await judge(poll, code('status=CE compile_output="main.py:1: SyntaxError"'));
    expect(v).toMatchObject({ verdict: 'CE', message: 'main.py:1: SyntaxError', failedFile: null });
  });

  it.each([
    ['status=SEGV', 'RE'],
    ['status=NZEC stderr="java.lang.OutOfMemoryError: heap"', 'MLE'],
    ['status=XFSZ', 'OLE'],
  ])('%s → %s on the first file', async (directives, verdict) => {
    const v = await judge(poll, code(directives));
    expect(v).toMatchObject({ verdict, failedFile: { ordinal: 1, kind: 'sample' } });
  });

  it('IE is retried once, then reported', async () => {
    const v = await judge(poll, code('status=IE'));
    expect(v.verdict).toBe('IE');
    expect(
      (await runsOf(poll, v.id))
        .filter((r) => r.fileOrdinal === 1)
        .map((r) => r.attempt)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('Run: samples only, plus the program output for custom input', async () => {
    const v = await judge(poll, code('program=echo'), { mode: 'run', customInput: 'hello\nworld' });
    expect(v.verdict).toBe('WA'); // echo isn't a+b
    expect(v.custom).toMatchObject({ stdout: 'hello\nworld' });
    expect((await runsOf(poll, v.id)).map((r) => r.fileOrdinal).sort()).toEqual([0, 1]);
  });

  it('survives Judge0 5xx: dispatch is retried by the poll schedule', async () => {
    await fetch(`${fakeUrl}/__fake/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 503, count: 2 }),
    });
    const v = await judge(poll, code('program=sum-cases'));
    expect(v.verdict).toBe('AC');
  });
});

describe('callback mode', () => {
  it('results arrive by Judge0 callbacks (well before the 15 s fallback poll)', async () => {
    const before = await fakeStats();
    const started = Date.now();
    const v = await judge(cb, code('program=sum-cases'));
    expect(v.verdict).toBe('AC');
    expect(Date.now() - started).toBeLessThan(12_000);
    expect((await fakeStats()).callbacks - before.callbacks).toBe(3);
  });

  it('rejects callbacks with a bad signature or token, even for a real run', async () => {
    // A real run, already judged: right run id and token, so only the checks under test can reject.
    const v = await judge(cb, code('program=sum-cases wrongCase=1'));
    const [run] = (await runsOf(cb, v.id)).filter((r) => r.fileOrdinal === 1);
    const forgedResult = {
      token: run!.judge0Token,
      status: { id: 3 },
      stdout: Buffer.from('3\n7\n').toString('base64'),
      time: '0.01',
      memory: 1,
    };
    const put = (sig: string, payload: object) =>
      cb.app.inject({ method: 'PUT', url: `/api/v1/hooks/judge0/${run!.id}?sig=${sig}`, payload });

    expect((await put('nope', forgedResult)).statusCode).toBe(401); // bad signature
    const otherRun = newId();
    expect((await put(cb.infra.judging.signature(otherRun), forgedResult)).statusCode).toBe(401); // someone else's sig
    expect((await put(cb.infra.judging.signature(run!.id), { ...forgedResult, token: 'x' })).statusCode).toBe(
      401,
    ); // wrong token
    // a valid replay after the run is done is accepted but changes nothing
    expect((await put(cb.infra.judging.signature(run!.id), forgedResult)).statusCode).toBe(204);
    const [still] = (await runsOf(cb, v.id)).filter((r) => r.fileOrdinal === 1);
    expect(still!.stdoutTrunc).toBe(run!.stdoutTrunc);
  });
});

describe('intake gates', () => {
  it('verdict cache: identical code on the same version costs no Judge0 calls', async () => {
    const src = code('program=sum-cases');
    const first = await judge(poll, src);
    const before = (await fakeStats()).created;
    const again = await judge(poll, src); // another user, same code
    expect(again).toMatchObject({ verdict: first.verdict, fromCache: true });
    expect((await fakeStats()).created).toBe(before);
  });

  it('the same user can’t resubmit unchanged code', async () => {
    const token = await player();
    const src = code('program=sum-cases');
    const a = await submit(poll, token, src);
    await result(poll, token, a.json().submissionId);
    const b = await submit(poll, token, `${src}\n\n`); // whitespace doesn't count as a change
    expect([b.statusCode, b.json().error.code]).toEqual([409, 'CODE_UNCHANGED']);
  });

  it('caps submits per match', async () => {
    const token = await player();
    const matchId = newId();
    for (let i = 0; i < 3; i++)
      expect((await submit(poll, token, code('status=CE'), { matchId })).statusCode).toBe(202);
    const r = await submit(poll, token, code('status=CE'), { matchId });
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'SUBMISSION_LIMIT_REACHED']);
  });

  it('budget: practice stops at the match reserve, matches can use it, nothing passes zero', async () => {
    const day = sql`(now() at time zone 'utc')::date`;
    const set = (used: number) =>
      poll.infra.db.db
        .update(judgeBudgetDaily)
        .set({ callsUsed: used })
        .where(sql`${judgeBudgetDaily.day} = ${day}`);
    await set(500 - 41); // 41 left: a practice submit (2 batch requests) would leave 39 < reserve 40
    const practice = await submit(poll, await player(), code('program=sum-cases'));
    expect([practice.statusCode, practice.json().error.code]).toEqual([503, 'JUDGE_AT_CAPACITY']);
    const inMatch = await submit(poll, await player(), code('program=sum-cases'), { matchId: newId() });
    expect(inMatch.statusCode).toBe(202);
    await set(500);
    const none = await submit(poll, await player(), code('program=sum-cases'), { matchId: newId() });
    expect(none.json().error.code).toBe('JUDGE_AT_CAPACITY');
    const capacity = await poll.app.inject({
      method: 'GET',
      url: '/internal/capacity',
      headers: { authorization: `Bearer ${await signInternalToken(SECRET, 'battle-service')}` },
    });
    expect(capacity.json()).toMatchObject({
      remaining: 0,
      limit: 500,
      breaker: 'closed',
      level: 'no_new_matches',
    });
    await set(0);
  });

  it('counts Judge0 requests like RapidAPI: a 3-file submit is two batches, not three calls', async () => {
    await quiet(poll);
    const before = await usedToday(poll);
    const v = await judge(poll, code('program=sum-cases'));
    expect(v.verdict).toBe('AC');
    expect((await usedToday(poll)) - before).toBe(2); // sample + small, then large
  });

  it('degradation ladder: custom input pauses below 30%, Runs throttle below 15%, Submits go on', async () => {
    const day = sql`(now() at time zone 'utc')::date`;
    const set = (used: number) =>
      poll.infra.db.db
        .update(judgeBudgetDaily)
        .set({ callsUsed: used })
        .where(sql`${judgeBudgetDaily.day} = ${day}`);
    const status = async () => (await poll.app.inject({ method: 'GET', url: '/api/v1/judge/status' })).json();

    await set(500 - 140); // 28% left
    const p = await player();
    const custom = await submit(poll, p, code('program=echo'), { mode: 'run', customInput: '1\n1 2\n' });
    expect([custom.statusCode, custom.json().error.code]).toEqual([503, 'JUDGE_AT_CAPACITY']);
    expect((await submit(poll, p, code('program=sum-cases'), { mode: 'run' })).statusCode).toBe(202);
    expect(await status()).toEqual({ level: 'no_custom_input', available: true });

    await set(500 - 70); // 14% left
    const q = await player();
    expect((await submit(poll, q, code('program=sum-cases'), { mode: 'run' })).statusCode).toBe(202);
    const again = await submit(poll, q, code('program=sum-cases'), { mode: 'run' });
    expect([again.statusCode, again.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect((await submit(poll, q, code('program=sum-cases'))).statusCode).toBe(202);
    expect(await status()).toEqual({ level: 'runs_throttled', available: true });
    await set(0);
  });

  it('drafts are only for problem setters; unverified users and unknown languages are refused', async () => {
    expect((await submit(poll, await player(), code('x'), { problemId: DRAFT_ID })).statusCode).toBe(404);
    expect(
      (await submit(poll, await player('problem_setter'), code('program=sum-cases'), { problemId: DRAFT_ID }))
        .statusCode,
    ).toBe(202);
    expect((await submit(poll, await player('user', false), code('x'))).json().error.code).toBe(
      'EMAIL_NOT_VERIFIED',
    );
    expect((await submit(poll, await player(), code('x'), { languageKey: 'rust' })).statusCode).toBe(400);
  });

  it('resolves language ids from Judge0 and lists them', async () => {
    const r = (await poll.app.inject({ method: 'GET', url: '/api/v1/languages' })).json() as {
      items: { key: string }[];
    };
    expect(r.items.map((l) => l.key).sort()).toEqual(['cpp', 'java', 'javascript', 'python']);
  });

  it('emits created and judged events through the outbox', async () => {
    const v = await judge(poll, code('program=sum-cases wrongCase=1'));
    const types = (await poll.infra.db.db.select().from(outbox).where(eq(outbox.key, v.id))).map(
      (e) => e.type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'judge.submission.created.v1',
        'judge.submission.progress.v1',
        'judge.submission.judged.v1',
      ]),
    );
  });
});

describe('calibration runs (internal)', () => {
  const calibrate = async (code: string, cpuLimitMs: number, requestKey = crypto.randomUUID()) =>
    poll.app.inject({
      method: 'POST',
      url: '/internal/calibrations',
      payload: { problemId: PROBLEM_ID, languageKey: 'python', code, cpuLimitMs, requestKey },
      headers: { authorization: `Bearer ${await signInternalToken(SECRET, 'problem-service')}` },
    });
  const until = async (id: string) =>
    waitFor(
      async () => {
        const r = (
          await poll.app.inject({
            method: 'GET',
            url: `/internal/calibrations/${id}`,
            headers: { authorization: `Bearer ${await signInternalToken(SECRET, 'problem-service')}` },
          })
        ).json() as {
          status: string;
          files: { ordinal: number; verdict: string; cpuMs: number }[];
          cpuLimitMs: number;
        };
        return r.status === 'done' ? r : undefined;
      },
      { what: 'calibration', timeoutMs: 45_000, intervalMs: 200 },
    );

  it('runs every file with the override limit, no fail-fast, and reports per-file times', async () => {
    const r = await calibrate(code('program=sum-cases time=0.3'), 5000);
    expect(r.statusCode).toBe(202);
    const done = await until(r.json().id);
    expect(done.cpuLimitMs).toBe(5000);
    expect(done.files.map((f) => [f.ordinal, f.verdict, f.cpuMs])).toEqual([
      [1, 'AC', 300],
      [2, 'AC', 300],
      [3, 'AC', 300],
    ]);
  });

  it('keeps judging after a failure and measures TLE without near-miss reruns', async () => {
    const wa = await until((await calibrate(code('program=sum-cases wrongCase=3'), 5000)).json().id);
    // sample has only 2 cases; small and large both fail case 3, and large still ran (no fail-fast)
    expect(wa.files.map((f) => f.verdict)).toEqual(['AC', 'WA', 'WA']);
    // 25 KB × 0.21 s/KB ≈ 5.25 s > 5 s: a near-miss that a normal submit would rerun
    const r = await calibrate(code('program=sum-cases timePerKb=0.21'), 5000);
    const tle = await until(r.json().id);
    expect(tle.files.find((f) => f.ordinal === 3)).toMatchObject({ verdict: 'TLE' });
    expect((await runsOf(poll, r.json().id)).filter((x) => x.fileOrdinal === 3)).toHaveLength(1);
  });

  it('is idempotent by requestKey and emits no user events', async () => {
    const key = crypto.randomUUID();
    const a = (await calibrate(code('program=sum-cases'), 3000, key)).json();
    const b = (await calibrate(code('program=sum-cases'), 3000, key)).json();
    expect(b.id).toBe(a.id);
    await until(a.id);
    expect(await poll.infra.db.db.select().from(outbox).where(eq(outbox.key, a.id))).toHaveLength(0);
  });
});

describe('drift (plan §14.8)', () => {
  it('three checks build the baseline, each one batch request; admins see it, players do not', async () => {
    await quiet(poll);
    const before = await usedToday(poll);
    for (let i = 0; i < 3; i++) expect((await poll.infra.drift.check()).error).toBeNull();
    expect((await usedToday(poll)) - before).toBe(3);

    const view = await poll.app.inject({
      method: 'GET',
      url: '/api/v1/admin/judge',
      headers: { authorization: `Bearer ${await player('admin')}` },
    });
    expect(view.json()).toMatchObject({
      capacity: { level: 'normal' },
      drift: { factor: 1, checks: 3, baseline: { cpp: 10, python: 10 }, lastCheck: { error: null } },
    });
    const denied = await poll.app.inject({
      method: 'GET',
      url: '/api/v1/admin/judge',
      headers: { authorization: `Bearer ${await player()}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('a drift factor scales every CPU limit (1.5 s passes a 1 s limit at factor 2)', async () => {
    const setFactor = async (factor: string) => {
      await poll.infra.db.db
        .insert(judgeDriftChecks)
        .values({ id: newId(), samples: { cpp: 10, python: 10 }, ratio: factor, factor });
      await poll.infra.drift.load();
    };
    await setFactor('2.00');
    try {
      expect((await judge(poll, code('program=sum-cases time=1.5'))).verdict).toBe('AC');
    } finally {
      await setFactor('1.00');
    }
    expect((await judge(poll, code('program=sum-cases time=1.5'))).verdict).toBe('TLE');
  });
});

describe('degraded mode (plan §18.1)', () => {
  it('with the queue down, Postgres drives judging end to end; leftover jobs are no-ops afterwards', async () => {
    await quiet(poll);
    await poll.worker.submitWorker.pause();
    await poll.worker.pollWorker.pause();
    queueDown.poll = true;
    // the leader loop does this every 2 s in production; here we drive it directly
    const ticker = setInterval(() => void poll.worker.degradedTick(), 300);
    let id: string;
    try {
      const v = await judge(poll, code('program=sum-cases'));
      expect(v).toMatchObject({ verdict: 'AC', failedFile: null });
      id = v.id;
    } finally {
      clearInterval(ticker);
      queueDown.poll = false;
      poll.worker.submitWorker.resume();
      poll.worker.pollWorker.resume();
    }
    expect((await runsOf(poll, id)).map((r) => [r.stage, r.fileOrdinal]).sort()).toEqual([
      [1, 1],
      [1, 2],
      [2, 3],
    ]);
    // the judge-submit job queued meanwhile now runs: it must not judge the submission again
    await quiet(poll);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await runsOf(poll, id)).toHaveLength(3);
  });
});
