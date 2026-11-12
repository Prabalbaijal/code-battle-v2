import type { Db } from '@cb/db';
import type { Logger } from '@cb/logger';
import type { BreakerState } from '@cb/resilience';
import { lt, sql } from 'drizzle-orm';
import { judgeBreakers } from '../db/schema.js';

const RANK: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * The Judge0 breaker as the whole service sees it (Phase 6 chaos drill 4 found the gap): the worker
 * trips its breaker, but admission control asks the API process, whose own breaker never sees a
 * Judge0 call. Every process writes its transitions here; `state()` is the worst live one.
 */
export class BreakerBoard {
  private cached: { at: number; state: BreakerState } | undefined;

  constructor(private readonly d: { db: Db; nodeId: string; logger: Logger; cacheMs?: number }) {}

  /** Record a transition (fire-and-forget from the breaker's callback). */
  record(state: BreakerState, openUntil: Date | null): void {
    this.cached = undefined;
    void this.d.db
      .insert(judgeBreakers)
      .values({ nodeId: this.d.nodeId, state, openUntil, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: judgeBreakers.nodeId,
        set: { state, openUntil, updatedAt: sql`now()` },
      })
      .catch((err: unknown) => this.d.logger.warn({ err }, 'could not record the judge breaker state'));
  }

  /**
   * Worst state across processes. `open` counts only until its reset time (after that the owner is
   * probing, or gone): it then reads as `half_open`, which doesn't refuse new matches.
   */
  async state(local: BreakerState): Promise<BreakerState> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > (this.d.cacheMs ?? 2000)) {
      const rows = await this.d.db.select().from(judgeBreakers);
      let worst: BreakerState = 'closed';
      for (const r of rows) {
        const s: BreakerState =
          r.state === 'open' && r.openUntil && r.openUntil.getTime() > now
            ? 'open'
            : r.state === 'closed'
              ? 'closed'
              : 'half_open';
        if (RANK[s] > RANK[worst]) worst = s;
      }
      this.cached = { at: now, state: worst };
    }
    return RANK[local] > RANK[this.cached.state] ? local : this.cached.state;
  }

  /** Rows of processes that stopped long ago (nightly). */
  async sweep(): Promise<void> {
    await this.d.db.delete(judgeBreakers).where(lt(judgeBreakers.updatedAt, sql`now() - interval '1 day'`));
  }
}
