import { createHttpServer, type HttpServer } from '@cb/http-server';
import { gauge } from '@cb/metrics';
import { Hub } from './hub.js';
import type { Infra } from './infra.js';
import { registerPresenceRoutes } from './routes.js';

/** One realtime node: presence HTTP API + Socket.IO on the same server. */
export async function buildApp(infra: Infra): Promise<{ app: HttpServer; hub: Hub }> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { redis: infra.safeRedis.ping },
    // presence degrades without Redis; delivery doesn't need it
    critical: [],
    openapi: { title: 'realtime-service', version: '1.0.0' },
  });
  registerPresenceRoutes(app, {
    store: infra.store,
    directory: infra.directory,
    auth: infra.authHooks,
    internalAuth: infra.internalAuth,
  });
  const hub = new Hub({
    httpServer: app.server,
    logger: infra.logger,
    verifier: infra.verifier,
    store: infra.store,
    directory: infra.directory,
    kafka: infra.kafka,
    nodeId: infra.env.NODE_ID,
    redis: infra.safeRedis,
    subscriber: infra.subscriber,
    corsOrigins: infra.env.CORS_ORIGINS,
    offlineDebounceMs: infra.env.PRESENCE_OFFLINE_DEBOUNCE_MS,
    maxConnectionsPerUser: infra.env.MAX_CONNECTIONS_PER_USER,
  });
  // plan §19: sockets on this node, and players online across the cluster (Redis; 0 if it's down)
  gauge('socket_connections', 'Open Socket.IO connections on this node', [], (g) =>
    g.set(hub.io.engine.clientsCount),
  );
  gauge('presence_online_users', 'Players online (all nodes)', [], async (g) =>
    g.set(await infra.store.count()),
  );
  await hub.start();
  // plan §13.6: on shutdown, tell clients to reconnect before the server goes away
  app.addHook('preClose', async () => hub.close());
  return { app, hub };
}
