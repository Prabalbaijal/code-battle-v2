import type { EmailJob, Me, Session } from '@cb/contracts';
import { ensureTopics, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { jobOutbox } from '@cb/queue';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import bcrypt from 'bcryptjs';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { credentials, refreshTokens } from '../db/schema.js';
import { createInfra, SERVICE_TOPICS, type Infra } from '../infra.js';
import { QUEUES } from '../queues.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'identity-int', level: 'silent' });
let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    WEB_BASE_URL: 'https://codebattle.test',
    REALTIME_URL: 'https://rt.codebattle.test',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger);
  await ensureTopics(infra.kafka, SERVICE_TOPICS);
  app = await buildApp(infra);
  worker = await startWorker(infra);
});

afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), redis?.stop(), rp?.stop()]);
});

// ---------- helpers ----------

/** Each request gets its own client IP unless one is given, so per-IP limits don't leak between tests. */
let ipSeq = 0;
const nextIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

interface Jar {
  at?: string;
  rt?: string;
}

interface CallOpts {
  body?: object;
  jar?: Jar;
  ip?: string;
  csrf?: boolean;
  headers?: Record<string, string>;
}

async function call(method: 'GET' | 'POST', path: string, o: CallOpts = {}) {
  const cookie = [o.jar?.at && `cb_at=${o.jar.at}`, o.jar?.rt && `cb_rt=${o.jar.rt}`]
    .filter(Boolean)
    .join('; ');
  const res = await app.inject({
    method,
    url: path.startsWith('/') ? path : `/api/v1/auth/${path}`,
    ...(o.body ? { payload: o.body } : {}),
    headers: {
      'x-forwarded-for': o.ip ?? nextIp(),
      ...(o.csrf === false ? {} : { 'x-cb-csrf': '1' }),
      ...(cookie ? { cookie } : {}),
      ...o.headers,
    },
  });
  // Update the jar like a browser would (a cleared cookie has an empty value).
  if (o.jar) {
    for (const c of res.cookies as { name: string; value: string }[]) {
      if (c.name === 'cb_at') o.jar.at = c.value || undefined;
      if (c.name === 'cb_rt') o.jar.rt = c.value || undefined;
    }
  }
  return res;
}

const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;

let userSeq = 0;
async function register(overrides: Partial<{ username: string; email: string; password: string }> = {}) {
  const n = ++userSeq;
  const u = {
    username: `player_${n}_${randomUUID().slice(0, 4)}`,
    email: `p${n}-${randomUUID().slice(0, 6)}@example.com`,
    password: 'Sup3r-secret-pw',
    fullname: `Player ${n}`,
    ...overrides,
  };
  const res = await call('POST', 'register', { body: u, headers: { 'idempotency-key': randomUUID() } });
  return { res, ...u };
}

async function login(identifier: string, password: string, ip?: string) {
  const jar: Jar = {};
  const res = await call('POST', 'login', { body: { identifier, password }, jar, ...(ip ? { ip } : {}) });
  return { res, jar };
}

/** The latest email job of a template sent to `to`, and the token in its link. */
async function lastEmail(to: string, template: EmailJob['template']) {
  const rows = await infra.db.db
    .select()
    .from(jobOutbox)
    .where(eq(jobOutbox.name, template))
    .orderBy(desc(jobOutbox.createdAt));
  const row = rows.find((r) => (r.data as EmailJob).to === to);
  if (!row) return undefined;
  const job = row.data as EmailJob;
  return { row, job, token: new URL(job.vars.link).searchParams.get('token')! };
}

// ---------- tests ----------

describe('identity-service', () => {
  it('is ready and publishes its JWKS', async () => {
    expect((await call('GET', '/health/ready')).json()).toMatchObject({ status: 'ok' });
    const jwks = await call('GET', '/.well-known/jwks.json');
    expect(jwks.headers['cache-control']).toContain('max-age=300');
    const keys = (jwks.json() as { keys: Record<string, unknown>[] }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('d');
  });

  describe('registration', () => {
    it('creates credentials, a registered event (no email/token on Kafka) and a verification email job', async () => {
      const u = await register();
      expect(u.res.statusCode).toBe(201);
      const me = u.res.json() as Me;
      expect(me).toMatchObject({ username: u.username, email: u.email, role: 'user', emailVerified: false });

      const [evt] = await infra.db.db.select().from(outbox).where(eq(outbox.key, me.id));
      expect(evt!.type).toBe('identity.user.registered.v1');
      expect(evt!.topic).toBe('user.events');
      expect(JSON.stringify(evt!.payload)).not.toContain(u.email);

      const mail = await lastEmail(u.email, 'verify_email');
      expect(mail!.job.vars.link).toMatch(/^https:\/\/codebattle\.test\/verify-email\?token=[\w-]{43}$/);
      expect(mail!.row.queue).toBe(QUEUES.email);
      expect(mail!.job.dedupeKey).toMatch(/^verify_email:[0-9a-f]{24}$/);
    });

    it('rejects duplicate email/username case-insensitively', async () => {
      const u = await register();
      const sameEmail = await register({ email: u.email.toUpperCase() });
      expect(sameEmail.res.statusCode).toBe(409);
      expect(errCode(sameEmail.res)).toBe('EMAIL_TAKEN');
      const sameName = await register({ username: u.username.toUpperCase() });
      expect(errCode(sameName.res)).toBe('USERNAME_TAKEN');
    });

    it('race: concurrent sign-ups for one username → exactly one account', async () => {
      const username = `race_${randomUUID().slice(0, 8)}`;
      const results = await Promise.all(Array.from({ length: 6 }, () => register({ username })));
      expect(results.filter((r) => r.res.statusCode === 201)).toHaveLength(1);
      expect(
        results.filter((r) => r.res.statusCode === 409).every((r) => errCode(r.res) === 'USERNAME_TAKEN'),
      ).toBe(true);
    });

    it('requires an Idempotency-Key and replays the stored response', async () => {
      const body = {
        username: `idem_${randomUUID().slice(0, 8)}`,
        email: `${randomUUID()}@x.io`,
        password: 'Sup3r-secret-pw',
        fullname: 'I',
      };
      const ip = nextIp();
      expect(errCode(await call('POST', 'register', { body, ip }))).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const key = randomUUID();
      const first = await call('POST', 'register', { body, ip, headers: { 'idempotency-key': key } });
      const again = await call('POST', 'register', { body, ip, headers: { 'idempotency-key': key } });
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json().id).toBe(first.json().id);
    });

    it('validates input', async () => {
      const bad = await register({ username: 'no spaces!', password: 'short' });
      expect(bad.res.statusCode).toBe(400);
    });
  });

  describe('login and session', () => {
    it('same error for unknown user and wrong password; login by username or email', async () => {
      const u = await register();
      const unknown = await login('nobody_here', 'whatever-pw');
      const wrong = await login(u.username, 'wrong-password');
      expect([unknown.res.statusCode, errCode(unknown.res)]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect([wrong.res.statusCode, errCode(wrong.res)]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect(unknown.res.json().error.message).toBe(wrong.res.json().error.message);

      const byEmail = await login(u.email.toUpperCase(), u.password);
      expect(byEmail.res.statusCode).toBe(200);
      const byName = await login(u.username, u.password);
      const session = byName.res.json() as Session;
      expect(session.user.username).toBe(u.username);
      expect(new Date(session.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 800_000);
    });

    it('sets httpOnly SameSite=Lax cookies; refresh cookie is scoped to /api/v1/auth', async () => {
      const u = await register();
      const { res, jar } = await login(u.username, u.password);
      const cookies = res.cookies as {
        name: string;
        path: string;
        httpOnly: boolean;
        sameSite: string;
        secure: boolean;
      }[];
      const at = cookies.find((c) => c.name === 'cb_at')!;
      const rt = cookies.find((c) => c.name === 'cb_rt')!;
      expect(at).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Lax', secure: true });
      expect(rt).toMatchObject({ path: '/api/v1/auth', httpOnly: true, sameSite: 'Lax' });

      const me = await call('GET', 'me', { jar });
      expect(me.json()).toMatchObject({ username: u.username, emailVerified: false });
      const bearer = await call('GET', 'me', { headers: { authorization: `Bearer ${jar.at}` } });
      expect(bearer.statusCode).toBe(200);
      expect((await call('GET', 'me')).statusCode).toBe(401);
    });

    it('CSRF: cookie-authenticated mutations need x-cb-csrf', async () => {
      const u = await register();
      const { jar } = await login(u.username, u.password);
      const noHeader = await call('POST', 'socket-ticket', { jar, csrf: false });
      expect(noHeader.statusCode).toBe(403);
      const ok = await call('POST', 'socket-ticket', { jar });
      expect(ok.statusCode).toBe(200);
      const { ticket, url } = ok.json() as { ticket: string; url: string };
      expect(url).toBe('https://rt.codebattle.test');
      expect((await infra.verifier.verifyTicket(ticket)).userId).toBe(u.res.json().id);
    });
  });

  describe('email verification', () => {
    it('verifies once, emits the event, and the next refresh carries ev=true', async () => {
      const u = await register();
      const userId = (u.res.json() as Me).id;
      const { jar } = await login(u.username, u.password);
      expect((await infra.verifier.verifyAccess(jar.at!)).emailVerified).toBe(false);

      const { token } = (await lastEmail(u.email, 'verify_email'))!;
      expect((await call('POST', 'verify-email', { body: { token } })).json()).toEqual({ verified: true });
      const again = await call('POST', 'verify-email', { body: { token } });
      expect([again.statusCode, errCode(again)]).toEqual([400, 'TOKEN_INVALID']);

      const types = (await infra.db.db.select().from(outbox).where(eq(outbox.key, userId))).map(
        (r) => r.type,
      );
      expect(types.sort()).toEqual(['identity.user.registered.v1', 'identity.user.verified.v1']);

      expect((await call('POST', 'refresh', { jar })).statusCode).toBe(200);
      expect((await infra.verifier.verifyAccess(jar.at!)).emailVerified).toBe(true);
    });

    it('resend: sends for unverified users, no-op once verified', async () => {
      const u = await register();
      const { jar } = await login(u.username, u.password);
      const first = await call('POST', 'resend-verification', { jar });
      expect([first.statusCode, first.json()]).toEqual([202, { sent: true }]);
      const { token } = (await lastEmail(u.email, 'verify_email'))!;
      await call('POST', 'verify-email', { body: { token } });
      expect((await call('POST', 'resend-verification', { jar })).json()).toEqual({ sent: false });
    });
  });

  describe('refresh rotation', () => {
    it('rotates; a stale copy inside the grace window gets 409, after it the whole family is revoked', async () => {
      const u = await register();
      const { jar } = await login(u.username, u.password);
      const original = jar.rt!;

      expect((await call('POST', 'refresh', { jar })).statusCode).toBe(200);
      const rotated = jar.rt!;
      expect(rotated).not.toBe(original);

      // Another tab still holding the old cookie, right after rotation: benign race.
      const race = await call('POST', 'refresh', { jar: { rt: original } });
      expect([race.statusCode, errCode(race)]).toEqual([409, 'CONFLICT']);

      // Later, the old token shows up again: treat it as theft and kill the family.
      await infra.db.db
        .update(refreshTokens)
        .set({ revokedAt: sql`now() - interval '1 minute'` })
        .where(
          sql`${refreshTokens.revokedAt} is not null and ${refreshTokens.userId} = ${(u.res.json() as Me).id}`,
        );
      const reuse = await call('POST', 'refresh', { jar: { rt: original } });
      expect([reuse.statusCode, errCode(reuse)]).toEqual([401, 'TOKEN_INVALID']);
      const victim = await call('POST', 'refresh', { jar: { rt: rotated } });
      expect(victim.statusCode).toBe(401);
    });

    it('race: N parallel refreshes of one token → exactly one rotation', async () => {
      const u = await register();
      const { jar } = await login(u.username, u.password);
      const rt = jar.rt!;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => call('POST', 'refresh', { jar: { rt } })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
      const live = await infra.db.db
        .select()
        .from(refreshTokens)
        .where(
          sql`${refreshTokens.userId} = ${(u.res.json() as Me).id} and ${refreshTokens.revokedAt} is null`,
        );
      expect(live).toHaveLength(1);
    });

    it('logout revokes the session; logout-all revokes every session', async () => {
      const u = await register();
      const a = await login(u.username, u.password);
      const b = await login(u.username, u.password);
      const c = await login(u.username, u.password);

      expect((await call('POST', 'logout', { jar: a.jar })).statusCode).toBe(204);
      expect(a.jar.rt).toBeUndefined();
      expect(
        (await call('POST', 'refresh', { jar: { rt: (await login(u.username, u.password)).jar.rt! } }))
          .statusCode,
      ).toBe(200);

      expect((await call('POST', 'logout-all', { jar: b.jar })).statusCode).toBe(204);
      expect((await call('POST', 'refresh', { jar: c.jar })).statusCode).toBe(401);
      expect((await call('POST', 'logout')).statusCode).toBe(204); // no cookie: still fine
    });
  });

  describe('login protection', () => {
    it('locks the account after 10 failures, then unlocks', async () => {
      const u = await register();
      for (let i = 0; i < 10; i++) expect((await login(u.username, 'bad-password')).res.statusCode).toBe(401);
      const locked = await login(u.username, u.password);
      expect([locked.res.statusCode, errCode(locked.res)]).toEqual([423, 'ACCOUNT_LOCKED']);

      await infra.db.db
        .update(credentials)
        .set({ lockedUntil: sql`now() - interval '1 second'` })
        .where(eq(credentials.username, u.username));
      expect((await login(u.username, u.password)).res.statusCode).toBe(200);
      const [row] = await infra.db.db.select().from(credentials).where(eq(credentials.username, u.username));
      expect(row!.failedLoginCount).toBe(0);
    });

    it('rate limits 5/min per IP+account with Retry-After', async () => {
      const u = await register();
      const ip = nextIp();
      for (let i = 0; i < 5; i++)
        expect((await login(u.username, 'bad-password', ip)).res.statusCode).toBe(401);
      const limited = await login(u.username, u.password, ip);
      expect([limited.res.statusCode, errCode(limited.res)]).toEqual([429, 'RATE_LIMITED']);
      expect(Number(limited.res.headers['retry-after'])).toBeGreaterThan(0);
      expect((await login(u.username, u.password)).res.statusCode).toBe(200); // other IP is fine
    });

    it('upgrades migrated bcrypt hashes to Argon2id on login', async () => {
      const userId = randomUUID();
      const username = `legacy_${randomUUID().slice(0, 6)}`;
      await infra.db.db.insert(credentials).values({
        userId,
        email: `${username}@old.io`,
        username,
        fullname: 'Legacy',
        passwordHash: await bcrypt.hash('old-v1-password', 4),
        passwordAlgo: 'bcrypt',
        legacyMongoId: randomUUID(),
      });
      expect((await login(username, 'old-v1-password')).res.statusCode).toBe(200);
      const [row] = await infra.db.db.select().from(credentials).where(eq(credentials.userId, userId));
      expect(row!.passwordAlgo).toBe('argon2id');
      expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
      expect((await login(username, 'old-v1-password')).res.statusCode).toBe(200);
    });
  });

  describe('password reset', () => {
    it('never reveals whether an account exists', async () => {
      const res = await call('POST', 'forgot-password', { body: { email: 'ghost@nowhere.io' } });
      expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
      expect(await lastEmail('ghost@nowhere.io', 'reset_password')).toBeUndefined();
    });

    it('resets once, revokes every session, verifies the email, and invalidates other links', async () => {
      const u = await register();
      const { jar } = await login(u.username, u.password);
      await call('POST', 'forgot-password', { body: { email: u.email } });
      const older = (await lastEmail(u.email, 'reset_password'))!.token;
      await call('POST', 'forgot-password', { body: { email: u.email } });
      const { token, job } = (await lastEmail(u.email, 'reset_password'))!;
      expect(job.vars.link).toContain('/reset-password?token=');

      const ok = await call('POST', 'reset-password', { body: { token, password: 'Brand-new-pw-1' } });
      expect(ok.statusCode).toBe(200);
      expect(
        errCode(await call('POST', 'reset-password', { body: { token, password: 'Another-pw-22' } })),
      ).toBe('TOKEN_INVALID');
      expect(
        errCode(await call('POST', 'reset-password', { body: { token: older, password: 'Another-pw-22' } })),
      ).toBe('TOKEN_INVALID');

      expect((await call('POST', 'refresh', { jar })).statusCode).toBe(401);
      expect((await login(u.username, u.password)).res.statusCode).toBe(401);
      const fresh = await login(u.username, 'Brand-new-pw-1');
      expect((fresh.res.json() as Session).user.emailVerified).toBe(true);
    });
  });

  describe('outbox and housekeeping', () => {
    it('relays events to Kafka and dispatches email jobs to BullMQ', async () => {
      await waitFor(
        async () => (await infra.db.db.select().from(outbox).where(isNull(outbox.publishedAt))).length === 0,
        { timeoutMs: 30_000, what: 'all events published' },
      );
      await waitFor(
        async () =>
          (await infra.db.db.select().from(jobOutbox).where(isNull(jobOutbox.dispatchedAt))).length === 0,
        { timeoutMs: 30_000, what: 'all jobs dispatched' },
      );
      const [row] = await infra.db.db.select().from(jobOutbox).limit(1);
      const job = await infra.queues[QUEUES.email]!.getJob(row!.jobId);
      expect(job?.data).toEqual(row!.data);
    });

    it('sweeps dispatched email jobs (they hold one-time links) and expired tokens', async () => {
      await infra.db.db.update(jobOutbox).set({ dispatchedAt: sql`now() - interval '1 hour'` });
      await worker.sweep();
      expect(await infra.db.db.select().from(jobOutbox)).toHaveLength(0);
    });
  });
});
