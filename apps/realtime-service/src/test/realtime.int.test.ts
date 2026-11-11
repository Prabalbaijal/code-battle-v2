import { generateSigningKey, JwtVerifier, signInternalToken, TokenSigner } from '@cb/auth';
import {
  battleEvents,
  judgeEvents,
  TOPICS,
  type EventEnvelope,
  type Player,
  type ServerEnvelope,
} from '@cb/contracts';
import { createProducer } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { newId } from '@cb/ids';
import { createLogger } from '@cb/logger';
import { startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import type { Producer } from 'kafkajs';
import type { AddressInfo } from 'node:net';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import type { Directory } from '../directory.js';
import { createInfra, type Infra } from '../infra.js';

const logger = createLogger({ service: 'realtime-int', level: 'silent' });
const SECRET = 'realtime-test-internal-secret-0123456789';

let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let signer: TokenSigner;
let infra: Infra;
let app: HttpServer;
let url: string;
let producer: Producer;
const sockets: Socket[] = [];

// ---------------- stubbed user-service ----------------
const people = new Map<string, Player>();
const friends = new Map<string, Set<string>>();
const directory: Directory = {
  friendIds: async (id) => [...(friends.get(id) ?? [])],
  players: async (ids) => new Map(ids.filter((id) => people.has(id)).map((id) => [id, people.get(id)!])),
  forgetFriends: () => undefined,
};
const befriend = (a: string, b: string) => {
  friends.set(a, (friends.get(a) ?? new Set()).add(b));
  friends.set(b, (friends.get(b) ?? new Set()).add(a));
};

beforeAll(async () => {
  [redis, rp] = await Promise.all([startRedis(), startRedpanda()]);
  signer = await TokenSigner.create([await generateSigningKey('r')]);
  const env = readEnv({
    NODE_ENV: 'test',
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
    INTERNAL_SERVICE_SECRET: SECRET,
    NODE_ID: 'test-node',
    PRESENCE_OFFLINE_DEBOUNCE_MS: '200',
    MAX_CONNECTIONS_PER_USER: '2',
  });
  infra = await createInfra(env, logger, {
    verifier: new JwtVerifier({ jwks: signer.publicJwks() }),
    directory,
  });
  ({ app } = await buildApp(infra));
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  producer = createProducer(infra.kafka);
  await producer.connect();
}, 240_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await producer?.disconnect();
  await app?.close();
  await infra?.close();
  await Promise.all([redis?.stop(), rp?.stop()]);
});

// ---------------- helpers ----------------

interface U {
  id: string;
  name: string;
}
const user = (name: string): U => {
  const id = newId();
  people.set(id, { id, username: name, fullname: `${name} Tester`, avatarUrl: null });
  return { id, name };
};

/** Connect with a fresh ticket; resolves once connected (or rejects with the server's reason). */
async function connect(
  u: U,
  ticket?: string,
): Promise<Socket & { received: ServerEnvelope<unknown>[]; events: string[] }> {
  const t = ticket ?? (await signer.signTicket(u.id)).ticket;
  const s = connectSocket(url, {
    transports: ['websocket'],
    auth: { ticket: t },
    reconnection: false,
    forceNew: true,
  });
  const received: ServerEnvelope<unknown>[] = [];
  const events: string[] = [];
  s.onAny((event: string, msg: ServerEnvelope<unknown>) => {
    events.push(event);
    received.push({ ...msg, type: event });
  });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', (err) => reject(err));
  });
  return Object.assign(s, { received, events });
}

const got = (
  s: { received: ServerEnvelope<unknown>[] },
  type: string,
  match: (d: never) => boolean = () => true,
): Promise<ServerEnvelope<unknown>> =>
  waitFor(async () => s.received.find((m) => m.type === type && match(m.data as never)), {
    what: type,
    timeoutMs: 15_000,
  });

const api = async (u: U, method: 'GET' | 'POST', path: string, body?: object) =>
  app.inject({
    method,
    url: path,
    ...(body ? { payload: body } : {}),
    headers: {
      authorization: `Bearer ${(await signer.signAccess({ userId: u.id, role: 'user', emailVerified: true }, 900)).token}`,
    },
  });

const status = async (of: U) =>
  (await api(of, 'POST', '/api/v1/presence/query', { userIds: [of.id] })).json().statuses[of.id];

/** The node's consumer may still be joining its group: publish until the event arrives. */
async function publishUntil(
  topic: string,
  key: string,
  make: () => EventEnvelope<unknown>,
  arrived: () => boolean,
) {
  for (let i = 0; i < 20 && !arrived(); i++) {
    await producer.send({ topic, messages: [{ key, value: JSON.stringify(make()) }] });
    await waitFor(async () => (arrived() ? true : undefined), { what: 'delivery', timeoutMs: 1500 }).catch(
      () => undefined,
    );
  }
  expect(arrived()).toBe(true);
}
const envelope = (type: string, data: object, recipients?: string[]): EventEnvelope<unknown> => ({
  id: newId(),
  type,
  source: 'test',
  occurredAt: new Date().toISOString(),
  aggregateId: newId(),
  ...(recipients ? { recipients } : {}),
  data,
});

// ---------------- tests ----------------

describe('connecting', () => {
  it('needs a valid ticket, and a ticket works only once', async () => {
    const a = user('ticket_a');
    await expect(connect(a, 'not-a-ticket')).rejects.toThrow('UNAUTHORIZED');
    const { ticket } = await signer.signTicket(a.id);
    const s = await connect(a, ticket);
    expect(s.connected).toBe(true);
    await expect(connect(a, ticket)).rejects.toThrow('TICKET_USED');
  });

  it('at most MAX_CONNECTIONS_PER_USER sockets per user', async () => {
    const a = user('many_a');
    await connect(a);
    await connect(a);
    await expect(connect(a)).rejects.toThrow('TOO_MANY_CONNECTIONS');
  });
});

describe('presence', () => {
  it('online while connected (list, search, count), offline after the debounce', async () => {
    const a = user('zara_presence');
    const s = await connect(a);
    expect(await status(a)).toBe('online');
    const page = (await api(a, 'GET', '/api/v1/presence/online?limit=50')).json();
    expect(page.items.map((p: { userId: string }) => p.userId)).toContain(a.id);
    const found = (await api(a, 'GET', '/api/v1/presence/online/search?prefix=ZARA')).json();
    expect(found.items).toEqual([
      expect.objectContaining({ userId: a.id, username: 'zara_presence', status: 'online' }),
    ]);
    expect((await api(a, 'GET', '/api/v1/presence/online/count')).json().count).toBeGreaterThanOrEqual(1);

    s.disconnect();
    await waitFor(async () => ((await status(a)) === 'offline' ? true : undefined), {
      what: 'offline',
      timeoutMs: 5000,
    });
    const svc = await signInternalToken(SECRET, 'battle-service');
    const internal = await app.inject({
      method: 'POST',
      url: '/internal/presence/query',
      payload: { userIds: [a.id] },
      headers: { authorization: `Bearer ${svc}` },
    });
    expect(internal.json().statuses[a.id]).toBe('offline');
  });

  it('friends get a snapshot on connect and live updates; strangers get nothing', async () => {
    const [a, b, stranger] = [user('fa'), user('fb'), user('fs')];
    befriend(a.id, b.id);
    const sb = await connect(b);
    const snap = await got(sb, 'presence:snapshot');
    expect((snap.data as { friends: { userId: string; status: string }[] }).friends).toEqual([
      expect.objectContaining({ userId: a.id, status: 'offline' }),
    ]);
    const ss = await connect(stranger);

    const sa = await connect(a);
    await got(
      sb,
      'presence:update',
      (d: { userId: string; status: string }) => d.userId === a.id && d.status === 'online',
    );
    const aSnap = await got(sa, 'presence:snapshot');
    expect((aSnap.data as { friends: { userId: string; status: string }[] }).friends[0]).toMatchObject({
      userId: b.id,
      status: 'online',
    });
    sa.disconnect();
    await got(
      sb,
      'presence:update',
      (d: { userId: string; status: string }) => d.userId === a.id && d.status === 'offline',
    );
    expect(ss.events).not.toContain('presence:update');
  });
});

describe('delivery from Kafka', () => {
  it('a challenge reaches its recipient only', async () => {
    const [a, b] = [user('ca'), user('cb')];
    const [sa, sb] = [await connect(a), await connect(b)];
    const challengeId = newId();
    await publishUntil(
      TOPICS.battle,
      challengeId,
      () =>
        envelope(
          battleEvents.challengeCreatedV1.type,
          {
            challengeId,
            fromUserId: a.id,
            toUserId: b.id,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            from: { username: 'ca', fullname: 'ca Tester', avatarUrl: null },
          },
          [b.id],
        ),
      () => sb.events.includes('challenge:received'),
    );
    expect(sa.events).not.toContain('challenge:received');
  });

  it('a match: both told (with seq), friends see in_match, verdict details only to the submitter', async () => {
    const [a, b, friend] = [user('ma'), user('mb'), user('mf')];
    befriend(a.id, friend.id);
    const [sa, sb, sf] = [await connect(a), await connect(b), await connect(friend)];
    const matchId = newId();
    const problemId = newId();
    const started = () =>
      envelope(
        battleEvents.matchStartedV1.type,
        {
          matchId,
          problemId,
          userIds: [a.id, b.id],
          startedAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 1_800_000).toISOString(),
          version: 1,
        },
        [a.id, b.id],
      );
    await publishUntil(TOPICS.battle, matchId, started, () => sa.events.includes('match:started'));
    const m = await got(sb, 'match:started');
    expect(m.seq).toBe(1);
    await got(
      sf,
      'presence:update',
      (d: { userId: string; status: string }) => d.userId === a.id && d.status === 'in_match',
    );
    expect(await status(a)).toBe('in_match');

    const submissionId = newId();
    await producer.send({
      topic: TOPICS.judge,
      messages: [
        {
          key: matchId,
          value: JSON.stringify(
            envelope(judgeEvents.submissionJudgedV1.type, {
              submissionId,
              matchId,
              userId: a.id,
              problemId,
              mode: 'submit',
              verdict: 'WA',
              failedFile: 2,
              failedCase: 3,
              maxCpuMs: 10,
              maxMemKb: 900,
              fromCache: false,
              submittedAt: new Date().toISOString(),
              judgedAt: new Date().toISOString(),
            }),
          ),
        },
      ],
    });
    const verdict = await got(sa, 'submission:verdict');
    expect(verdict.data).toMatchObject({ submissionId, verdict: 'WA', failedCase: 3 });
    const activity = await got(sb, 'match:opponent-activity');
    expect(activity.data).toEqual({ matchId, type: 'judged', verdict: 'WA' });
    expect(sb.events).not.toContain('submission:verdict');

    await producer.send({
      topic: TOPICS.battle,
      messages: [
        {
          key: matchId,
          value: JSON.stringify(
            envelope(
              battleEvents.matchCompletedV1.type,
              {
                matchId,
                problemId,
                userIds: [a.id, b.id],
                winnerId: b.id,
                endReason: 'solved',
                results: { [a.id]: 'loss', [b.id]: 'win' },
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                version: 2,
              },
              [a.id, b.id],
            ),
          ),
        },
      ],
    });
    const ended = await got(sa, 'match:ended');
    expect(ended).toMatchObject({ seq: 2, data: { winnerId: b.id, endReason: 'solved' } });
    await got(
      sf,
      'presence:update',
      (d: { userId: string; status: string }) => d.userId === a.id && d.status === 'online',
    );
  });
});
