import { generateSigningKey, JwtVerifier, signInternalToken, TokenSigner } from '@cb/auth';
import { identityEvents, TOPICS, type EventEnvelope, type Profile, type ProfileView } from '@cb/contracts';
import { createProducer, ensureTopics, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { and, eq, isNull } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { friendships, profiles } from '../db/schema.js';
import { createInfra, SERVICE_TOPICS, type Infra } from '../infra.js';
import { pairOf } from '../modules/friends/friends.repository.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'users-int', level: 'silent' });
const INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef';
let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let signer: TokenSigner;
let producer: Producer;

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'k',
    CLOUDINARY_API_SECRET: 's',
  });
  await migrate(env.DATABASE_URL);
  signer = await TokenSigner.create([await generateSigningKey('test')]);
  infra = await createInfra(env, logger, { verifier: new JwtVerifier({ jwks: signer.publicJwks() }) });
  await ensureTopics(infra.kafka, SERVICE_TOPICS);
  app = await buildApp(infra);
  worker = await startWorker(infra, { fromBeginning: true });
  producer = createProducer(infra.kafka);
  await producer.connect();
});

afterAll(async () => {
  await producer?.disconnect();
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), redis?.stop(), rp?.stop()]);
});

// ---------- helpers ----------

interface User {
  id: string;
  username: string;
  token: string;
}

const registeredEnvelope = (id: string, username: string): EventEnvelope<unknown> => ({
  id: newId(),
  type: identityEvents.userRegisteredV1.type,
  source: 'identity-service',
  occurredAt: new Date().toISOString(),
  aggregateId: id,
  data: {
    userId: id,
    username,
    fullname: `Full ${username}`,
    role: 'user',
    registeredAt: new Date().toISOString(),
  },
});

/** Publishes identity's registration event to Kafka (the real path) and waits for the profile. */
async function user(
  name = `u_${randomUUID().slice(0, 8)}`,
  opts: { verified?: boolean } = {},
): Promise<User> {
  const id = newId();
  await producer.send({
    topic: TOPICS.user,
    messages: [{ key: id, value: JSON.stringify(registeredEnvelope(id, name)) }],
  });
  await waitFor(
    async () => (await infra.db.db.select().from(profiles).where(eq(profiles.userId, id))).length === 1,
    {
      what: `profile ${name}`,
      timeoutMs: 30_000,
    },
  );
  const { token } = await signer.signAccess(
    { userId: id, role: 'user', emailVerified: opts.verified ?? true },
    900,
  );
  return { id, username: name, token };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(
  method: Method,
  url: string,
  as?: User,
  body?: object,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    ...(body ? { payload: body } : {}),
    headers: { ...(as ? { authorization: `Bearer ${as.token}` } : {}), ...headers },
  });
}
const code = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;
const befriend = (from: User, to: User) =>
  call('POST', '/api/v1/friends/requests', from, { toUserId: to.id }, { 'idempotency-key': randomUUID() });
const relationship = async (viewer: User, target: User) =>
  ((await call('GET', `/api/v1/users/${target.username}`, viewer)).json() as ProfileView).relationship;
const rows = async (a: User, b: User) => {
  const { low, high } = pairOf(a.id, b.id);
  return infra.db.db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userLow, low), eq(friendships.userHigh, high)));
};

// ---------- tests ----------

describe('profiles', () => {
  it('creates the profile from identity.user.registered.v1 exactly once', async () => {
    const id = newId();
    const env = registeredEnvelope(id, `once_${randomUUID().slice(0, 6)}`);
    expect(await worker.consumer.process(JSON.stringify(env))).toBe('processed');
    expect(await worker.consumer.process(JSON.stringify(env))).toBe('duplicate');
    // a different event id for the same user is still harmless (insert ... on conflict do nothing)
    expect(await worker.consumer.process(JSON.stringify({ ...env, id: newId() }))).toBe('processed');
    expect(await infra.db.db.select().from(profiles).where(eq(profiles.userId, id))).toHaveLength(1);
  });

  it('serves me and public profiles; relationship only for logged-in viewers', async () => {
    const a = await user();
    const me = (await call('GET', '/api/v1/users/me', a)).json() as Profile;
    expect(me).toMatchObject({ id: a.id, username: a.username, avatarUrl: null, bio: null });
    const anon = (await call('GET', `/api/v1/users/${a.username.toUpperCase()}`)).json() as ProfileView;
    expect(anon.id).toBe(a.id);
    expect(anon.relationship).toBeUndefined();
    expect(await relationship(a, a)).toBe('self');
    expect((await call('GET', '/api/v1/users/nobody_here')).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/users/me')).statusCode).toBe(401);
  });

  it('updates fullname/bio, emits user.profile.updated.v1, and guards avatar URLs', async () => {
    const a = await user();
    const res = await call('PATCH', '/api/v1/users/me', a, { fullname: 'New Name', bio: 'hi' });
    expect(res.json()).toMatchObject({ fullname: 'New Name', bio: 'hi' });
    const evts = await infra.db.db.select().from(outbox).where(eq(outbox.key, a.id));
    expect(evts.map((e) => e.type)).toContain('user.profile.updated.v1');

    const sig = (await call('POST', '/api/v1/users/me/avatar/upload-signature', a, {})).json() as {
      fields: Record<string, string>;
    };
    expect(sig.fields.public_id).toBe(a.id);
    const own = `https://res.cloudinary.com/demo/image/upload/v1/codebattle/avatars/${a.id}.webp`;
    expect((await call('PATCH', '/api/v1/users/me', a, { avatarUrl: own })).json()).toMatchObject({
      avatarUrl: own,
    });
    const other = own.replace(a.id, newId());
    expect((await call('PATCH', '/api/v1/users/me', a, { avatarUrl: other })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/v1/users/me', a, { avatarUrl: null })).json()).toMatchObject({
      avatarUrl: null,
    });
    expect((await call('PATCH', '/api/v1/users/me', a, {})).statusCode).toBe(400);
  });

  it('prefix search with keyset pagination, literal wildcards, and a fuzzy fallback', async () => {
    const tag = `zq${randomUUID().slice(0, 4)}`;
    const me = await user();
    for (const n of ['a1', 'a2', 'a3', 'b_1', 'bx1']) await user(`${tag}_${n}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `q=${tag}_a&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await call('GET', `/api/v1/users/search?${qs}`, me)).json() as {
        items: Profile[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((p) => p.username));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([`${tag}_a1`, `${tag}_a2`, `${tag}_a3`]);

    // "_" is a literal underscore, not a LIKE wildcard
    const lit = (await call('GET', `/api/v1/users/search?q=${tag}_b_`, me)).json() as { items: Profile[] };
    expect(lit.items.map((p) => p.username)).toEqual([`${tag}_b_1`]);

    // typo: prefix finds nothing, trigram finds the user
    const fuzzy = (await call('GET', `/api/v1/users/search?q=${tag}_bx2`, me)).json() as {
      items: Profile[];
      fuzzy: boolean;
    };
    expect(fuzzy.fuzzy).toBe(true);
    expect(fuzzy.items.map((p) => p.username)).toContain(`${tag}_bx1`);
    expect((await call('GET', '/api/v1/users/search?q=x&cursor=garbage', me)).statusCode).toBe(400);
  });

  it('internal batch needs a service token', async () => {
    const [a, b] = [await user(), await user()];
    const url = `/internal/users/batch?ids=${a.id},${b.id},${newId()}`;
    expect((await call('GET', url, a)).statusCode).toBe(401); // a user token is not a service token
    const token = await signInternalToken(INTERNAL_SECRET, 'gateway');
    const res = await call('GET', url, undefined, undefined, { authorization: `Bearer ${token}` });
    expect((res.json() as { items: Profile[] }).items.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('friends', () => {
  it('request → incoming/outgoing → accept → friends → remove', async () => {
    const [a, b] = [await user(), await user()];
    const sent = await befriend(a, b);
    expect(sent.json()).toMatchObject({ status: 'pending', user: { id: b.id } });
    expect(await relationship(a, b)).toBe('outgoing');
    expect(await relationship(b, a)).toBe('incoming');

    const incoming = (await call('GET', '/api/v1/friends/requests?direction=incoming', b)).json();
    expect(incoming.items.map((i: { user: Profile }) => i.user.id)).toEqual([a.id]);
    const outgoing = (await call('GET', '/api/v1/friends/requests?direction=outgoing', a)).json();
    expect(outgoing.items.map((i: { user: Profile }) => i.user.id)).toEqual([b.id]);

    // only the receiver can accept
    expect((await call('POST', `/api/v1/friends/requests/${b.id}/accept`, a)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/friends/requests/${a.id}/accept`, b)).statusCode).toBe(204);
    expect((await call('POST', `/api/v1/friends/requests/${a.id}/accept`, b)).statusCode).toBe(204); // idempotent
    expect(await relationship(a, b)).toBe('friends');
    expect(code(await befriend(a, b))).toBe('ALREADY_FRIENDS');

    const list = (await call('GET', '/api/v1/friends', b)).json();
    expect(list.items.map((f: Profile) => f.id)).toEqual([a.id]);

    // realtime's presence fan-out reads friend ids over an internal route
    const svc = { authorization: `Bearer ${await signInternalToken(INTERNAL_SECRET, 'realtime-service')}` };
    const ids = await call('GET', `/internal/users/${a.id}/friend-ids`, undefined, undefined, svc);
    expect(ids.json()).toEqual({ ids: [b.id] });
    expect((await call('GET', `/internal/users/${a.id}/friend-ids`, a)).statusCode).toBe(401);

    expect((await call('DELETE', `/api/v1/friends/${a.id}`, b)).statusCode).toBe(204);
    expect(await relationship(a, b)).toBe('none');
    expect((await call('DELETE', `/api/v1/friends/${a.id}`, b)).statusCode).toBe(404);
    expect(await rows(a, b)).toHaveLength(0);
  });

  it('a mutual request makes them friends', async () => {
    const [a, b] = [await user(), await user()];
    await befriend(a, b);
    expect((await befriend(b, a)).json()).toMatchObject({ status: 'accepted' });
    expect(await relationship(a, b)).toBe('friends');
  });

  it('race: concurrent A→B and B→A requests leave exactly one row', async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await user(), await user()];
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => befriend(a, b)),
        ...Array.from({ length: 4 }, () => befriend(b, a)),
      ]);
      for (const r of results) {
        if (r.statusCode !== 200)
          expect(['FRIEND_REQUEST_EXISTS', 'ALREADY_FRIENDS', 'CONFLICT']).toContain(code(r));
      }
      const pair = await rows(a, b);
      expect(pair).toHaveLength(1);
      expect(pair[0]!.status).toBe('accepted'); // both sides asked → friends
    }
  });

  it('reject is silent: the requester still sees "pending"', async () => {
    const [a, b] = [await user(), await user()];
    await befriend(a, b);
    expect((await call('POST', `/api/v1/friends/requests/${a.id}/reject`, b)).statusCode).toBe(204);
    expect(await relationship(a, b)).toBe('outgoing');
    expect(await relationship(b, a)).toBe('none');
    const again = await befriend(a, b);
    expect([again.statusCode, again.json().status]).toEqual([200, 'pending']);
    expect((await call('GET', '/api/v1/friends/requests?direction=incoming', b)).json().items).toHaveLength(
      0,
    );

    // B changes their mind and asks A: becomes B's pending request, A can accept.
    expect((await befriend(b, a)).json().status).toBe('pending');
    expect((await call('POST', `/api/v1/friends/requests/${b.id}/accept`, a)).statusCode).toBe(204);
    expect(await relationship(a, b)).toBe('friends');
  });

  it('cancel withdraws an outgoing request', async () => {
    const [a, b] = [await user(), await user()];
    await befriend(a, b);
    expect((await call('DELETE', `/api/v1/friends/requests/${b.id}`, a)).statusCode).toBe(204);
    expect(await relationship(b, a)).toBe('none');
    expect((await call('DELETE', `/api/v1/friends/requests/${b.id}`, a)).statusCode).toBe(404);
  });

  it('guards: verified email, self, unknown user, Idempotency-Key replay, CSRF', async () => {
    const [a, b] = [await user(), await user()];
    const unverified = await user(undefined, { verified: false });
    expect(code(await befriend(unverified, a))).toBe('EMAIL_NOT_VERIFIED');
    expect((await befriend(a, a)).statusCode).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/api/v1/friends/requests',
          a,
          { toUserId: newId() },
          { 'idempotency-key': randomUUID() },
        )
      ).statusCode,
    ).toBe(404);
    expect(code(await call('POST', '/api/v1/friends/requests', a, { toUserId: b.id }))).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );

    const key = randomUUID();
    const first = await call(
      'POST',
      '/api/v1/friends/requests',
      a,
      { toUserId: b.id },
      { 'idempotency-key': key },
    );
    const replay = await call(
      'POST',
      '/api/v1/friends/requests',
      a,
      { toUserId: b.id },
      { 'idempotency-key': key },
    );
    expect(first.statusCode).toBe(200);
    expect([replay.statusCode, replay.headers['idempotent-replayed']]).toEqual([200, 'true']);

    const viaCookie = await app.inject({
      method: 'POST',
      url: `/api/v1/friends/requests/${a.id}/accept`,
      headers: { cookie: `cb_at=${b.token}` },
    });
    expect(viaCookie.statusCode).toBe(403);
  });

  it('paginates friends newest first', async () => {
    const hub = await user();
    const others = [];
    for (let i = 0; i < 5; i++) {
      const o = await user();
      await befriend(o, hub);
      await call('POST', `/api/v1/friends/requests/${o.id}/accept`, hub);
      others.push(o.id);
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Profile[]; nextCursor: string | null } = (
        await call('GET', `/api/v1/friends?limit=2${cursor ? `&cursor=${cursor}` : ''}`, hub)
      ).json();
      ids.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual([...others].reverse());
  });

  it('emits friendship events keyed by user_low and relays them to Kafka', async () => {
    const [a, b] = [await user(), await user()];
    await befriend(a, b);
    await call('POST', `/api/v1/friends/requests/${a.id}/accept`, b);
    const { low } = pairOf(a.id, b.id);
    const evts = await infra.db.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.key, low), eq(outbox.type, 'user.friendship.changed.v1')));
    const changes = evts.map((e) => (e.payload as { data: { change: string } }).data.change);
    expect(changes.sort()).toEqual(['accepted', 'requested']);
    await waitFor(
      async () => (await infra.db.db.select().from(outbox).where(isNull(outbox.publishedAt))).length === 0,
      { what: 'events published' },
    );
  });
});
