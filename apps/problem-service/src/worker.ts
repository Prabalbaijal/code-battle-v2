import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { readEnv } from './config/env.js';
import { createInfra } from './infra.js';
import { startWorker } from './worker-runtime.js';

// Worker process
const env = readEnv();
const logger = createLogger({ service: `${env.SERVICE_NAME}-worker`, level: env.LOG_LEVEL });
const infra = await createInfra(env, logger);
const worker = await startWorker(infra);
logger.info('worker started');

registerGracefulShutdown(logger, [
  { name: 'worker', fn: () => worker.stop() },
  { name: 'infra', fn: () => infra.close() },
]);
