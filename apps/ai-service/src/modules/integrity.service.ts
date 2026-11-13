import type { AiUsage, InternalSubmission, IntegrityFlag } from '@cb/contracts';
import type { Db } from '@cb/db';
import { notFound } from '@cb/errors';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { counter } from '@cb/metrics';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Upstreams } from '../clients.js';
import { aiBudgetDaily, aiRequests, integrityFlags, type IntegrityFlagRow } from '../db/schema.js';
import { fingerprints, MIN_FINGERPRINTS, similarity } from '../lib/winnow.js';
import type { ReadModel } from './readmodel.service.js';

const flagged = counter('ai_integrity_flags_total', 'Integrity flags raised', ['relation']);

/** Flag thresholds: copying from the opponent mid-match, or from an earlier accepted solution. */
export const OPPONENT_THRESHOLD = 0.8;
export const EARLIER_THRESHOLD = 0.9;

/**
 * Anti-cheat signals (plan §22.2 #6): after each match, fingerprint both players' final code and
 * compare it with the opponent's and with recent accepted solutions to the same problem. A match
 * above the threshold becomes a flag for an admin, never an automatic penalty: similar code can be
 * honest (short problems, standard templates), so a human decides.
 */
export class IntegrityService {
  constructor(
    private readonly d: {
      db: Db;
      upstreams: Upstreams;
      readModel: ReadModel;
      logger: Logger;
      limits: { tokensPerModel: number; requestsPerModel: number };
      models: string[];
    },
  ) {}

  async check(matchId: string): Promise<number> {
    const match = await this.d.readModel.match(matchId);
    if (!match || match.status !== 'completed') return 0;
    const inMatch = await this.d.upstreams.submissions({ matchId, limit: 100 });
    // newest first: the first per player is their final submission
    const finals = new Map<string, InternalSubmission>();
    for (const s of inMatch) if (!finals.has(s.userId)) finals.set(s.userId, s);
    const earlier = (
      await this.d.upstreams.submissions({ problemId: match.problemId, verdict: 'AC', limit: 50 })
    ).filter(
      (s) => !match.userIds.includes(s.userId) && Date.parse(s.submittedAt) < match.startedAt.getTime(),
    );

    let raised = 0;
    const prints = new Map<string, Set<number>>();
    const fp = (s: InternalSubmission) => {
      let f = prints.get(s.id);
      if (!f) prints.set(s.id, (f = fingerprints(s.code)));
      return f;
    };
    for (const [userId, mine] of finals) {
      const a = fp(mine);
      if (a.size < MIN_FINGERPRINTS) continue; // too short to tell copying from coincidence
      const candidates: {
        other: InternalSubmission;
        relation: 'opponent' | 'earlier_submission';
        min: number;
      }[] = [
        ...[...finals.values()]
          .filter((s) => s.userId !== userId)
          .map((s) => ({ other: s, relation: 'opponent' as const, min: OPPONENT_THRESHOLD })),
        ...earlier.map((s) => ({
          other: s,
          relation: 'earlier_submission' as const,
          min: EARLIER_THRESHOLD,
        })),
      ];
      for (const c of candidates) {
        const b = fp(c.other);
        if (b.size < MIN_FINGERPRINTS) continue;
        const sim = similarity(a, b);
        if (sim < c.min) continue;
        const rows = await this.d.db
          .insert(integrityFlags)
          .values({
            id: newId(),
            matchId,
            problemId: match.problemId,
            userId,
            submissionId: mine.id,
            otherUserId: c.other.userId,
            otherSubmissionId: c.other.id,
            relation: c.relation,
            similarity: Math.round(sim * 1000) / 1000,
          })
          .onConflictDoNothing()
          .returning({ id: integrityFlags.id });
        if (rows.length) {
          raised++;
          flagged.inc({ relation: c.relation });
        }
      }
    }
    if (raised) this.d.logger.info({ matchId, raised }, 'integrity flags raised');
    return raised;
  }

  // ---------------- admin ----------------

  async flags(status: IntegrityFlag['status'] | undefined): Promise<IntegrityFlag[]> {
    const rows = await this.d.db
      .select()
      .from(integrityFlags)
      .where(status ? eq(integrityFlags.status, status) : undefined)
      .orderBy(desc(integrityFlags.createdAt))
      .limit(100);
    return rows.map(toFlag);
  }

  async review(
    id: string,
    adminId: string,
    status: 'cleared' | 'confirmed',
    note?: string,
  ): Promise<IntegrityFlag> {
    const [row] = await this.d.db
      .update(integrityFlags)
      .set({ status, note: note ?? null, reviewedBy: adminId })
      .where(eq(integrityFlags.id, id))
      .returning();
    if (!row) throw notFound('Flag');
    return toFlag(row);
  }

  async usage(): Promise<AiUsage> {
    const today = sql`(now() at time zone 'utc')::date`;
    const budget = await this.d.db.select().from(aiBudgetDaily).where(eq(aiBudgetDaily.day, today));
    const byFeature = await this.d.db
      .select({
        feature: aiRequests.feature,
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${aiRequests.inputTokens} + ${aiRequests.outputTokens}), 0)::int`,
      })
      .from(aiRequests)
      .where(and(sql`${aiRequests.createdAt} >= ${today}::timestamp at time zone 'utc'`))
      .groupBy(aiRequests.feature);
    const day = new Date().toISOString().slice(0, 10);
    return {
      day,
      models: this.d.models.map((model) => {
        const b = budget.find((r) => r.model === model);
        return {
          model,
          tokensUsed: b?.tokensUsed ?? 0,
          tokensLimit: this.d.limits.tokensPerModel,
          requestsUsed: b?.requestsUsed ?? 0,
          requestsLimit: this.d.limits.requestsPerModel,
        };
      }),
      byFeature,
    };
  }
}

const toFlag = (r: IntegrityFlagRow): IntegrityFlag => ({
  id: r.id,
  matchId: r.matchId,
  problemId: r.problemId,
  userId: r.userId,
  otherUserId: r.otherUserId,
  relation: r.relation,
  similarity: r.similarity,
  status: r.status,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});
