import type { Hint, HintRequest } from '@cb/contracts';
import type { Db } from '@cb/db';
import { AppError, conflict, notFound, unavailable } from '@cb/errors';
import type { Logger } from '@cb/logger';
import { counter } from '@cb/metrics';
import { and, asc, eq, lt } from 'drizzle-orm';
import type { Upstreams } from '../clients.js';
import { aiHints, type AiHintRow } from '../db/schema.js';
import type { ModelGateway } from '../llm/gateway.js';
import { fence, render, type Prompt } from '../llm/prompts.js';
import { leakGuardSchema } from '../llm/schemas.js';
import { clip, problemText } from './problem-text.js';
import type { ReadModel } from './readmodel.service.js';

const guarded = counter('ai_hint_guard_total', 'Hint leak guard outcomes', ['outcome']);
const forbidden = (message: string) => new AppError('AI_NOT_ALLOWED', 403, message);

/** Code in a hint is a leak whatever the model thinks: fenced blocks or several code-like lines. */
export function looksLikeCode(text: string): boolean {
  if (/```/.test(text)) return true;
  const codeLines = text
    .split('\n')
    .filter((l) =>
      /(^\s*(#include|import |def |for\s*\(|while\s*\(|int |long |public |class |return\b))|[;{}]\s*$/.test(
        l,
      ),
    );
  return codeLines.length >= 3;
}

/**
 * Progressive hints (plan §22.2 #2). Level n needs level n−1. In a battle a hint costs coins
 * (10/20/30) through rating-service's idempotent ledger; after the match the same hints are free.
 * Each hint is generated once per player, problem and level, checked by a leak guard (a cheap
 * structural check plus a second model call) and stored, so asking again costs nothing.
 */
export class HintService {
  private readonly inflight = new Map<string, Promise<Hint>>();

  constructor(
    private readonly d: {
      db: Db;
      gateway: ModelGateway;
      upstreams: Upstreams;
      readModel: ReadModel;
      prompts: { hint: Prompt; guard: Prompt };
      costs: [number, number, number];
      logger: Logger;
    },
  ) {}

  /** The player's hints for a problem that they may see (paid, or outside a battle). */
  async list(userId: string, problemId: string): Promise<Hint[]> {
    const rows = await this.d.db
      .select()
      .from(aiHints)
      .where(and(eq(aiHints.userId, userId), eq(aiHints.problemId, problemId)))
      .orderBy(asc(aiHints.level));
    return rows.filter((r) => r.paid).map((r) => this.view(r, 0, null));
  }

  async get(userId: string, req: HintRequest): Promise<Hint> {
    // one generation per (player, problem, level) at a time on this node; the PK covers the rest
    const key = `${userId}:${req.problemId}:${req.level}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.getOnce(userId, req).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async getOnce(userId: string, req: HintRequest): Promise<Hint> {
    const { problemId, level } = req;
    const problem = await this.d.readModel.problem(problemId);
    if (!problem || problem.status !== 'published') throw notFound('Problem');

    // where is the player with this problem? (only problems they've met in a match)
    const active = await this.d.readModel.activeMatch(userId);
    const inBattle = active && active.problemId === problemId ? active : undefined;
    if (req.matchId && (!inBattle || inBattle.matchId !== req.matchId))
      throw forbidden('That match isn’t running.');
    if (!inBattle && !(await this.d.readModel.playedProblem(userId, problemId))) {
      throw forbidden('Hints are for problems you’ve played.');
    }
    const cost = inBattle ? this.d.costs[level - 1]! : 0;

    const existing = await this.rows(userId, problemId);
    const mine = existing.find((r) => r.level === level);
    if (mine?.paid) return this.view(mine, 0, null);
    if (level > 1 && !existing.find((r) => r.level === level - 1 && r.paid)) {
      throw conflict('CONFLICT', `Open hint ${level - 1} first.`);
    }

    if (mine) {
      // generated earlier, but the charge didn't go through: only the charge is retried
      return this.payAndShow(userId, mine, inBattle?.matchId ?? null, cost);
    }
    if (cost > 0 && (await this.d.upstreams.coins(userId)) < cost) {
      throw conflict('INSUFFICIENT_COINS', `This hint costs ${cost} coins.`);
    }

    const statement = await this.d.upstreams.problem(problem.slug);
    if (!statement) throw notFound('Problem');
    const text = await this.generate(userId, problemText(statement), existing, level, req.code);
    const [row] = await this.d.db
      .insert(aiHints)
      .values({
        userId,
        problemId,
        level,
        text,
        matchId: inBattle?.matchId ?? null,
        paid: cost === 0,
        promptVersion: this.d.prompts.hint.version,
      })
      .onConflictDoNothing()
      .returning();
    // a parallel request on another node won the insert: use its hint (and its charge state)
    const stored = row ?? (await this.rows(userId, problemId)).find((r) => r.level === level)!;
    return this.payAndShow(userId, stored, inBattle?.matchId ?? null, cost);
  }

  private async payAndShow(
    userId: string,
    row: AiHintRow,
    matchId: string | null,
    cost: number,
  ): Promise<Hint> {
    if (row.paid || cost === 0 || !matchId) {
      if (!row.paid) await this.markPaid(row);
      return this.view(row, 0, null);
    }
    // throws INSUFFICIENT_COINS (409) and leaves the hint unpaid, i.e. hidden
    const charge = await this.d.upstreams.charge({
      userId,
      matchId,
      reason: `hint_${row.level}`,
      amount: cost,
    });
    await this.markPaid(row);
    return this.view(row, charge.charged ? cost : 0, charge.coins);
  }

  private async generate(
    userId: string,
    statement: string,
    earlier: AiHintRow[],
    level: number,
    code: string | undefined,
  ): Promise<string> {
    const { hint, guard } = this.d.prompts;
    const earlierText = earlier
      .filter((r) => r.level < level)
      .map((r) => `Level ${r.level}: ${r.text}`)
      .join('\n');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const text = (
        await this.d.gateway.text({
          feature: 'hint',
          tier: 'strong',
          userId,
          promptVersion: hint.version,
          maxTokens: 500,
          temperature: attempt === 1 ? 0.4 : 0.2,
          messages: [
            {
              role: 'system',
              content:
                attempt === 1
                  ? hint.system
                  : `${hint.system}\n\nYour previous answer gave too much away. Be vaguer this time.`,
            },
            {
              role: 'user',
              content: render(hint.user, {
                problem: fence(statement),
                earlier: fence(earlierText || '(none)'),
                code: code ? fence(clip(code, 4000)) : '(not shared)',
                level: String(level),
              }),
            },
          ],
        })
      ).trim();
      if (!text) continue;
      if (looksLikeCode(text)) {
        guarded.inc({ outcome: 'blocked_code' });
        continue;
      }
      const verdict = await this.d.gateway.json(
        {
          feature: 'hint_guard',
          tier: 'fast',
          userId,
          promptVersion: guard.version,
          maxTokens: 200,
          temperature: 0,
          messages: [
            { role: 'system', content: guard.system },
            {
              role: 'user',
              content: render(guard.user, {
                problem: fence(statement),
                level: String(level),
                hint: fence(text),
              }),
            },
          ],
        },
        leakGuardSchema,
      );
      if (!verdict.revealsSolution) {
        guarded.inc({ outcome: 'passed' });
        return text;
      }
      guarded.inc({ outcome: 'blocked_model' });
      this.d.logger.info({ level, reason: verdict.reason }, 'hint blocked by the leak guard');
    }
    throw unavailable(
      'AI_UNAVAILABLE',
      'Couldn’t write a hint that doesn’t give the answer away. Try again.',
    );
  }

  private rows(userId: string, problemId: string) {
    return this.d.db
      .select()
      .from(aiHints)
      .where(and(eq(aiHints.userId, userId), eq(aiHints.problemId, problemId), lt(aiHints.level, 4)))
      .orderBy(asc(aiHints.level));
  }

  private async markPaid(row: AiHintRow) {
    await this.d.db
      .update(aiHints)
      .set({ paid: true })
      .where(
        and(
          eq(aiHints.userId, row.userId),
          eq(aiHints.problemId, row.problemId),
          eq(aiHints.level, row.level),
        ),
      );
    row.paid = true;
  }

  private view(r: AiHintRow, charged: number, coins: number | null): Hint {
    return { problemId: r.problemId, level: r.level, text: r.text, charged, coins };
  }
}
