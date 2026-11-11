import type { JwtVerifier } from '@cb/auth';
import {
  envelopeBaseSchema,
  TOPICS,
  type ClientToServerEvents,
  type EnvelopeBase,
  type PresenceStatus,
  type ServerEnvelope,
  type ServerEventName,
  type ServerEvents,
  type ServerToClientEvents,
} from '@cb/contracts';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import type { Redis, SafeRedis } from '@cb/redis';
import type { Kafka, Consumer } from 'kafkajs';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { route, type Delivery, type SideEffect } from './delivery.js';
import type { Directory } from './directory.js';
import type { PresenceStore } from './presence.js';

interface SocketData {
  userId: string;
  /** The user's first connection anywhere (announce "online"). */
  first: boolean;
  window: { start: number; count: number };
}
type Io = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface HubDeps {
  httpServer: HttpServer;
  logger: Logger;
  verifier: JwtVerifier;
  store: PresenceStore;
  directory: Directory;
  kafka: Kafka;
  nodeId: string;
  /** Publisher (normal client) and a dedicated subscriber connection for presence changes. */
  redis: SafeRedis;
  subscriber: Redis;
  corsOrigins: string[];
  offlineDebounceMs: number;
  maxConnectionsPerUser: number;
}

const CHANNEL = 'presence:changes';
/** Plan §13.6: at most 30 inbound events per minute per connection, 1 KB payloads. */
const MAX_EVENTS_PER_MIN = 30;

/**
 * One realtime node (plan §13): sockets authenticated by single-use tickets, a Kafka consumer of
 * its own (every node sees every event and emits only to its local sockets), and presence.
 */
export class Hub {
  readonly io: Io;
  private consumer: Consumer | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly matchPlayers = new Map<string, string[]>();

  constructor(private readonly d: HubDeps) {
    this.io = new Server(d.httpServer, {
      transports: ['websocket'],
      maxHttpBufferSize: 1024,
      cors: { origin: d.corsOrigins, credentials: false },
      serveClient: false,
    });
  }

  async start(): Promise<void> {
    this.io.use(async (socket, next) => {
      const ticket = (socket.handshake.auth as { ticket?: unknown } | undefined)?.ticket;
      if (typeof ticket !== 'string') return next(new Error('UNAUTHORIZED'));
      let userId: string;
      try {
        const t = await this.d.verifier.verifyTicket(ticket);
        if (!(await this.d.store.claimTicket(t.jti))) return next(new Error('TICKET_USED'));
        userId = t.userId;
      } catch {
        return next(new Error('UNAUTHORIZED'));
      }
      // Register presence and join the room *before* the client sees `connect`, so a request or
      // an event right after connecting already finds the user online and reachable.
      const me = (await this.d.directory.players([userId]).catch(() => new Map())).get(userId);
      const count = await this.d.store.connect(userId, socket.id, me?.username ?? userId);
      if (count > this.d.maxConnectionsPerUser) {
        await this.d.store.disconnect(userId, socket.id);
        return next(new Error('TOO_MANY_CONNECTIONS'));
      }
      socket.data.userId = userId;
      socket.data.window = { start: Date.now(), count: 0 };
      socket.data.first = count === 1;
      await socket.join(`user:${userId}`);
      next();
    });
    this.io.on('connection', (socket) => {
      void this.onConnection(socket).catch((err: unknown) =>
        this.d.logger.warn({ err }, 'socket connection setup failed'),
      );
    });

    // presence changes from any node → every node tells its local friends
    await this.d.subscriber
      .subscribe(CHANNEL)
      .catch((err: unknown) =>
        this.d.logger.warn({ err }, 'presence subscription failed; friends get local updates only'),
      );
    this.d.subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const { userId, status } = JSON.parse(raw) as { userId: string; status: PresenceStatus };
        void this.tellFriends(userId, status);
      } catch {
        /* ignore malformed */
      }
    });

    this.consumer = this.d.kafka.consumer({ groupId: `realtime-${this.d.nodeId}` });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [TOPICS.battle, TOPICS.judge, TOPICS.user],
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const env = envelopeBaseSchema.safeParse(JSON.parse(message.value.toString()));
        if (!env.success) return;
        await this.handle(env.data).catch((err: unknown) =>
          this.d.logger.warn({ err, type: env.data.type }, 'realtime delivery failed'),
        );
      },
    });

    this.sweeper = setInterval(() => void this.d.store.sweep(), 30_000);
    this.sweeper.unref();
  }

  /** Kafka event → sockets on this node, plus presence side effects. */
  async handle(env: EnvelopeBase): Promise<void> {
    const { deliveries, effects } = route(env);
    for (const del of deliveries) await this.deliver(del);
    for (const e of effects) await this.apply(e);
  }

  private async deliver(del: Delivery): Promise<void> {
    if ('userIds' in del.to) return this.emit(del.to.userIds, del.event, del.message);
    const { matchId, userId } = del.to.opponentsOf;
    const players = await this.playersOf(matchId);
    this.emit(
      players.filter((id) => id !== userId),
      del.event,
      del.message,
    );
  }

  /**
   * Who plays a match. Every node consumes `match.started`, so memory answers without Redis
   * (delivery must not depend on it); Redis covers nodes that started after the match did.
   */
  private async playersOf(matchId: string): Promise<string[]> {
    return this.matchPlayers.get(matchId) ?? this.d.store.matchUsers(matchId);
  }

  private emit<K extends ServerEventName>(
    userIds: string[],
    event: K,
    message: ServerEnvelope<ServerEvents[K]>,
  ) {
    for (const id of userIds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io's typed emit can't follow K
      (this.io.local.to(`user:${id}`) as any).emit(event, message);
    }
  }

  private async apply(e: SideEffect): Promise<void> {
    switch (e.kind) {
      case 'match-started':
        this.matchPlayers.set(e.matchId, e.userIds);
        if (this.matchPlayers.size > 10_000) {
          // oldest first (Map keeps insertion order); finished matches go anyway
          this.matchPlayers.delete(this.matchPlayers.keys().next().value!);
        }
        await this.d.store.setInMatch(e.matchId, e.userIds);
        for (const id of e.userIds) await this.tellFriends(id, 'in_match');
        return;
      case 'match-over': {
        this.matchPlayers.delete(e.matchId);
        await this.d.store.clearInMatch(e.matchId, e.userIds);
        const statuses = await this.d.store.statuses(e.userIds);
        for (const id of e.userIds) await this.tellFriends(id, statuses[id] ?? 'offline');
        return;
      }
      case 'friendship': {
        this.d.directory.forgetFriends(e.userLow);
        this.d.directory.forgetFriends(e.userHigh);
        if (!e.accepted) return;
        // new friends see each other's status straight away
        const s = await this.d.store.statuses([e.userLow, e.userHigh]);
        this.emit(
          [e.userHigh],
          'presence:update',
          this.envelope('presence:update', { userId: e.userLow, status: s[e.userLow]! }),
        );
        this.emit(
          [e.userLow],
          'presence:update',
          this.envelope('presence:update', { userId: e.userHigh, status: s[e.userHigh]! }),
        );
        return;
      }
    }
  }

  private async onConnection(socket: Parameters<Parameters<Io['on']>[1]>[0]): Promise<void> {
    const { userId, first } = socket.data;
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending); // reconnected within the debounce: friends never saw "offline"
      this.offlineTimers.delete(userId);
    }

    socket.onAny(() => {
      const w = socket.data.window;
      if (Date.now() - w.start > 60_000) socket.data.window = { start: Date.now(), count: 0 };
      if (++socket.data.window.count > MAX_EVENTS_PER_MIN) socket.disconnect(true);
    });
    socket.on('presence:ping', () => void this.d.store.ping(userId));
    socket.on('disconnect', () => void this.onDisconnect(userId, socket.id));

    if (first && !pending) {
      const status = (await this.d.store.statuses([userId]))[userId] ?? 'online';
      await this.announce(userId, status);
    }
    await this.sendSnapshot(socket, userId);
  }

  private async onDisconnect(userId: string, connId: string): Promise<void> {
    const left = await this.d.store.disconnect(userId, connId);
    if (left > 0) return;
    // a reload or a flaky network shouldn't flash "offline" to friends (plan §13.3)
    this.offlineTimers.set(
      userId,
      setTimeout(() => {
        this.offlineTimers.delete(userId);
        void this.d.store.markOffline(userId).then(async (gone) => {
          if (gone) await this.announce(userId, 'offline');
        });
      }, this.d.offlineDebounceMs),
    );
  }

  /** A change seen by this node: publish so every node tells its local friends. */
  private async announce(userId: string, status: PresenceStatus): Promise<void> {
    const published = await this.d.redis.run(
      (c) => c.publish(CHANNEL, JSON.stringify({ userId, status })).then(() => true),
      () => false,
    );
    if (!published) await this.tellFriends(userId, status);
  }

  private async tellFriends(userId: string, status: PresenceStatus): Promise<void> {
    const friends = await this.d.directory.friendIds(userId).catch(() => []);
    this.emit(friends, 'presence:update', this.envelope('presence:update', { userId, status }));
  }

  private async sendSnapshot(socket: Parameters<Parameters<Io['on']>[1]>[0], userId: string): Promise<void> {
    const ids = await this.d.directory.friendIds(userId).catch(() => []);
    const [people, statuses] = await Promise.all([
      this.d.directory.players(ids).catch(() => new Map()),
      this.d.store.statuses(ids),
    ]);
    socket.emit(
      'presence:snapshot',
      this.envelope('presence:snapshot', {
        friends: ids
          .filter((id) => people.has(id))
          .map((id) => {
            const p = people.get(id)!;
            return {
              userId: id,
              username: p.username,
              fullname: p.fullname,
              avatarUrl: p.avatarUrl,
              status: statuses[id] ?? 'offline',
            };
          }),
      }),
    );
  }

  private envelope<K extends ServerEventName>(
    type: K,
    data: ServerEvents[K],
  ): ServerEnvelope<ServerEvents[K]> {
    return {
      eventId: newId(),
      type: `realtime.${type.replace(':', '.')}`,
      ts: new Date().toISOString(),
      data,
    };
  }

  /** Plan §13.6: tell clients to reconnect elsewhere, then close. */
  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.io.emit('server:reconnect', this.envelope('server:reconnect', {}));
    // the HTTP server belongs to Fastify, which closes it; here only the sockets go
    this.io.local.disconnectSockets(true);
    this.io.engine.close();
    await this.consumer?.disconnect().catch(() => undefined);
    this.d.subscriber.disconnect();
  }
}
