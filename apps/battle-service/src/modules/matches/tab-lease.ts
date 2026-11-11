import type { TabLeaseResult } from '@cb/contracts';
import { conflict, notFound } from '@cb/errors';
import { isOpen } from '@cb/match-rules';
import type { SafeRedis } from '@cb/redis';
import type { MatchService } from './matches.service.js';

export const TAB_LEASE_MS = 30_000;

// Grant when nobody holds it, when the holder renews, or on "Use here". Atomic in Redis.
const LEASE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or cur == ARGV[1] or ARGV[3] == '1' then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return {1, ARGV[1]}
end
return {0, cur}
`;

/**
 * Plan §13.5: only one browser tab plays a match at a time, so two tabs can't both submit or
 * show conflicting state. A UX guard, not a security boundary: it fails open without Redis.
 */
export class TabLeaseService {
  constructor(private readonly d: { redis: SafeRedis; matches: MatchService }) {}

  async acquire(userId: string, matchId: string, tabId: string, takeover: boolean): Promise<TabLeaseResult> {
    const p = await this.d.matches.participation(matchId, userId).catch(() => undefined);
    if (!p?.participant) throw notFound('Match');
    if (!isOpen(p.status)) throw conflict('MATCH_NOT_ACTIVE', 'This match is over');
    return this.d.redis.run(
      async (c) => {
        const [granted, holder] = (await c.eval(
          LEASE_SCRIPT,
          1,
          `battle-tab:${matchId}:${userId}`,
          tabId,
          String(TAB_LEASE_MS),
          takeover ? '1' : '0',
        )) as [number, string | null];
        return { granted: granted === 1, holder };
      },
      () => ({ granted: true, holder: tabId }),
    );
  }
}
