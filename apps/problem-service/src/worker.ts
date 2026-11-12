import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { initMetrics, startMetricsServer } from '@cb/metrics';
import { readEnv } from './config/env.js';
import { createInfra } from './infra.js';
import { startWorker } from './worker-runtime.js';

// Worker process
const env = readEnv();
const logger = createLogger({ service: `${env.SERVICE_NAME}-worker`, level: env.LOG_LEVEL });
// plan §19: workers have no HTTP server; Prometheus scrapes this port (private network only)
initMetrics(`${env.SERVICE_NAME}-worker`);
const metrics = process.env.METRICS_PORT ? startMetricsServer(Number(process.env.METRICS_PORT)) : undefined;
const infra = await createInfra(env, logger);
const worker = await startWorker(infra);
logger.info('worker started');

registerGracefulShutdown(logger, [
  { name: 'metrics', fn: async () => void metrics?.close() },
  { name: 'worker', fn: () => worker.stop() },
  { name: 'infra', fn: () => infra.close() },
]);
