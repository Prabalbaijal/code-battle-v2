import { createLogger } from '@cb/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedis, SafeRedis } from './index.js';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('SafeRedis (no server)', () => {
  const client = createRedis({ url: 'redis://127.0.0.1:1', role: 'cache', logger });
  afterEach(() => undefined);

  it('uses the fallback immediately when redis is unreachable', async () => {
    const safe = new SafeRedis(client, logger);
    const started = Date.now();
    const v = await safe.run(
      (r) => r.get('k'),
      () => 'fallback',
    );
    expect(v).toBe('fallback');
    expect(Date.now() - started).toBeLessThan(200);
    expect(safe.available).toBe(false);
    client.disconnect();
  });
});
