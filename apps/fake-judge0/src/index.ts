import { baseEnvSchema, loadEnv } from '@cb/env';
import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { buildFakeJudge0 } from './app.js';

const env = loadEnv(baseEnvSchema.extend({ PORT: baseEnvSchema.shape.PORT.default(2358) }), {
  SERVICE_NAME: 'fake-judge0',
  ...process.env,
});
const logger = createLogger({ service: env.SERVICE_NAME, level: env.LOG_LEVEL });
const app = await buildFakeJudge0({ logger });
await app.listen({ host: '0.0.0.0', port: env.PORT });
registerGracefulShutdown(logger, [{ name: 'http', fn: () => app.close() }]);
