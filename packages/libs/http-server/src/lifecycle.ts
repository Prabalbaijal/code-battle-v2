import type { Logger } from '@cb/logger';

export type ShutdownHandler = { name: string; fn: () => Promise<void> };

/**
 * Run shutdown handlers in order on SIGTERM/SIGINT (stop accepting work first, close pools last).
 * Forces exit if handlers take longer than `timeoutMs`.
 */
export function registerGracefulShutdown(logger: Logger, handlers: ShutdownHandler[], timeoutMs = 15_000) {
  let shuttingDown = false;
  const run = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    force.unref();
    for (const h of handlers) {
      try {
        await h.fn();
        logger.info({ handler: h.name }, 'shutdown step done');
      } catch (err) {
        logger.error({ err, handler: h.name }, 'shutdown step failed');
      }
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.once('SIGTERM', () => void run('SIGTERM'));
  process.once('SIGINT', () => void run('SIGINT'));
  return run;
}
