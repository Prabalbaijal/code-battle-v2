import type { Recommendations, TopicStat, Verdict } from '@cb/contracts';
import type { Db } from '@cb/db';
import { sql } from 'drizzle-orm';
import type { KnowledgeService } from './knowledge.service.js';

/** Notes that start a beginner off when there's no history yet. */
const STARTER_TAGS = ['complexity', 'implementation', 'math'];

type Row = {
  tag: string;
  attempts: number;
  solved: number;
  failed: number;
  common_verdict: string | null;
};

/**
 * Recommendations (plan §22.2 #4) without a model call: a weakness profile from the player's own
 * judged submissions, per problem tag (a topic counts as failed when the player never got AC on that
 * problem), mapped to the DSA notes on those topics. Free, instant and explainable.
 */
export class RecommendationService {
  constructor(private readonly d: { db: Db; knowledge: KnowledgeService }) {}

  async get(userId: string): Promise<Recommendations> {
    const res = await this.d.db.execute<Row>(sql`
      with per_problem as (
        select s.problem_id,
               bool_or(s.verdict = 'AC') as solved,
               mode() within group (order by s.verdict) filter (where s.verdict <> 'AC') as common_fail
        from ai_submissions s
        where s.user_id = ${userId}
        group by s.problem_id
      )
      select t.tag,
             count(*)::int as attempts,
             count(*) filter (where pp.solved)::int as solved,
             count(*) filter (where not pp.solved)::int as failed,
             mode() within group (order by pp.common_fail) as common_verdict
      from per_problem pp
      join ai_problems p on p.problem_id = pp.problem_id
      cross join lateral unnest(p.tags) as t(tag)
      group by t.tag`);
    const rows = res.rows;
    const notesFor = (tag: string) =>
      this.d.knowledge
        .noteSummaries()
        .filter((n) => n.tags.includes(tag.toLowerCase()))
        .slice(0, 3);

    const totalAttempts = rows.reduce((n, r) => n + r.attempts, 0);
    if (totalAttempts < 3) {
      return {
        basis: 'starter',
        weak: STARTER_TAGS.map((tag) => ({
          tag,
          attempts: 0,
          solved: 0,
          failed: 0,
          commonVerdict: null,
          notes: notesFor(tag),
        })).filter((t) => t.notes.length),
        strong: [],
      };
    }
    const weak: TopicStat[] = rows
      .filter((r) => r.failed > 0)
      // most failures first, then the worst failure rate (with a small prior so 1/1 isn't "worst")
      .sort(
        (a, b) =>
          b.failed - a.failed || (b.failed + 1) / (b.attempts + 2) - (a.failed + 1) / (a.attempts + 2),
      )
      .slice(0, 4)
      .map((r) => ({
        tag: r.tag,
        attempts: r.attempts,
        solved: r.solved,
        failed: r.failed,
        commonVerdict: (r.common_verdict as Verdict | null) ?? null,
        notes: notesFor(r.tag),
      }));
    const strong = rows
      .filter((r) => r.failed === 0 && r.solved > 0)
      .sort((a, b) => b.solved - a.solved)
      .slice(0, 5)
      .map((r) => r.tag);
    return { basis: 'history', weak, strong };
  }
}
