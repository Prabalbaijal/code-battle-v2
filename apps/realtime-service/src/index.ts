import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { buildApp } from './app.js';
import { readEnv } from './config/env.js';
import { createInfra } from './infra.js';

// One realtime node (HTTP presence API + Socket.IO)
const env = readEnv();
const logger = createLogger({ service: env.SERVICE_NAME, level: env.LOG_LEVEL });
const infra = await createInfra(env, logger);
const { app } = await buildApp(infra);
await app.listen({ host: '0.0.0.0', port: env.PORT });
logger.info({ nodeId: env.NODE_ID }, 'realtime node started');

registerGracefulShutdown(logger, [
  { name: 'http', fn: () => app.close() },
  { name: 'infra', fn: () => infra.close() },
]);
