import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { readEnv } from './config/env.js';
import { createInfra } from './infra.js';
import { startWorker } from './worker-runtime.js';

// Worker process
const env = readEnv();
const logger = createLogger({ service: `${env.SERVICE_NAME}-worker`, level: env.LOG_LEVEL });
const infra = await createInfra(env, logger);
// A new consumer group starts at the beginning: every registration and result still on the topics
// is applied (idempotent by inbox + ledger), so stats are complete even if rating started late.
const worker = await startWorker(infra, { fromBeginning: true });
logger.info('worker started');

registerGracefulShutdown(logger, [
  { name: 'worker', fn: () => worker.stop() },
  { name: 'infra', fn: () => infra.close() },
]);
