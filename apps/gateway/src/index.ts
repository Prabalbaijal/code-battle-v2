import { JwtVerifier } from '@cb/auth';
import { registerGracefulShutdown } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { RateLimiter } from '@cb/rate-limit';
import { createRedis, SafeRedis } from '@cb/redis';
import { readEnv } from './config/env.js';
import { buildGateway } from './gateway.js';

const env = readEnv();
const logger = createLogger({ service: env.SERVICE_NAME, level: env.LOG_LEVEL });
const redis = createRedis({ url: env.REDIS_URL, role: 'cache', logger, name: env.SERVICE_NAME });
const safeRedis = new SafeRedis(redis, logger);

const app = await buildGateway({
  env,
  logger,
  verifier: new JwtVerifier({ jwksUrl: env.JWKS_URL }),
  limiter: new RateLimiter({
    redis: safeRedis,
    logger,
    prefix: 'gateway:ip',
    capacity: env.RATE_LIMIT_PER_IP_PER_MIN,
    refillPerSec: env.RATE_LIMIT_PER_IP_PER_MIN / 60,
  }),
  redisPing: safeRedis.ping,
});
await app.listen({ host: '0.0.0.0', port: env.PORT });

registerGracefulShutdown(logger, [
  { name: 'http', fn: () => app.close() },
  { name: 'redis', fn: async () => redis.disconnect() },
]);
