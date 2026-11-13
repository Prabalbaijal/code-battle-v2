import type { AiReview, AiReviewContent } from '@cb/contracts';
import { withTransaction, type Db } from '@cb/db';
import { AppError, notFound } from '@cb/errors';
import type { Logger } from '@cb/logger';
import { and, eq, sql } from 'drizzle-orm';
import type { Upstreams } from '../clients.js';
import { aiReviews } from '../db/schema.js';
import type { ModelGateway } from '../llm/gateway.js';
import { fence, render, type Prompt } from '../llm/prompts.js';
import { reviewSchema } from '../llm/schemas.js';
import { enqueueTask } from '../lib/tasks.js';
import { clip, problemText } from './problem-text.js';
import type { ReadModel } from './readmodel.service.js';

const forbidden = (message: string) => new AppError('AI_NOT_ALLOWED', 403, message);

/**
 * The post-match coach (plan §22.2 #1). Opt-in: a player asks for a review of a finished match,
 * a task is enqueued (durable, idempotent per match and player), and the worker writes it. The
 * opponent's code goes to the model for the comparison but is never shown to the player.
 */
export class ReviewService {
  constructor(
    private readonly d: {
      db: Db;
      gateway: ModelGateway;
      upstreams: Upstreams;
      readModel: ReadModel;
      prompt: Prompt;
      logger: Logger;
    },
  ) {}

  async request(userId: string, matchId: string): Promise<AiReview> {
    const match = await this.d.readModel.match(matchId);
    if (!match || !match.userIds.includes(userId)) throw notFound('Match');
    if (match.status !== 'completed') throw forbidden('Reviews are for finished matches.');
    if (!this.d.gateway.enabled)
      throw new AppError('AI_DISABLED', 503, 'AI features are switched off on this server.');
    await withTransaction(this.d.db, async (tx) => {
      const [row] = await tx
        .insert(aiReviews)
        .values({ matchId, userId, status: 'pending' })
        .onConflictDoUpdate({
          // asking again after a failure tries again; a ready review stays as it is
          target: [aiReviews.matchId, aiReviews.userId],
          set: { status: 'pending', error: null, updatedAt: sql`now()` },
          setWhere: sql`${aiReviews.status} = 'failed'`,
        })
        .returning();
      if (row)
        await enqueueTask(tx, 'review', `${matchId}:${userId}`, { matchId, userId }, { replace: true });
    });
    return this.get(userId, matchId);
  }

  async get(userId: string, matchId: string): Promise<AiReview> {
    const [r] = await this.d.db
      .select()
      .from(aiReviews)
      .where(and(eq(aiReviews.matchId, matchId), eq(aiReviews.userId, userId)));
    if (!r) throw notFound('Review');
    return {
      matchId,
      status: r.status,
      review: (r.content as AiReviewContent | null) ?? null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Worker: write the review. Throws to retry (the task runner backs off). */
  async process(matchId: string, userId: string): Promise<void> {
    const [row] = await this.d.db
      .select()
      .from(aiReviews)
      .where(and(eq(aiReviews.matchId, matchId), eq(aiReviews.userId, userId)));
    if (!row || row.status === 'ready') return;
    const match = await this.d.readModel.match(matchId);
    if (!match) throw new Error('match not in the read model yet');
    const problem = await this.d.readModel.problem(match.problemId);
    const statement = problem ? await this.d.upstreams.problem(problem.slug) : null;
    if (!statement) throw new Error('problem statement unavailable');

    // newest first: the first one per player is their final submission
    const subs = await this.d.upstreams.submissions({ matchId, limit: 100 });
    const mine = subs.find((s) => s.userId === userId);
    const theirs = subs.find((s) => s.userId !== userId);
    const result =
      match.winnerId === null
        ? `no winner (${match.endReason ?? 'ended'})`
        : match.winnerId === userId
          ? 'you won'
          : 'you lost';

    const content = await this.d.gateway.json(
      {
        feature: 'review',
        tier: 'fast',
        userId,
        promptVersion: this.d.prompt.version,
        maxTokens: 1500,
        messages: [
          { role: 'system', content: this.d.prompt.system },
          {
            role: 'user',
            content: render(this.d.prompt.user, {
              problem: fence(problemText(statement)),
              result,
              verdict: mine
                ? `${mine.verdict ?? 'not judged'}${mine.failedFile ? ` on the ${mine.failedFile.kind} tests, case ${mine.failedCase ?? '?'}` : ''}`
                : 'no submission',
              language: mine?.languageKey ?? 'none',
              code: mine ? fence(clip(mine.code)) : '(no submission)',
              opponent: theirs ? fence(clip(theirs.code, 4000)) : '',
            }),
          },
        ],
      },
      reviewSchema,
    );
    await this.d.db
      .update(aiReviews)
      .set({
        status: 'ready',
        content,
        promptVersion: this.d.prompt.version,
        model: 'fast',
        error: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(aiReviews.matchId, matchId), eq(aiReviews.userId, userId)));
  }

  /** After the last retry: tell the player instead of leaving them waiting. */
  async fail(matchId: string, userId: string, err: unknown): Promise<void> {
    const message =
      err instanceof AppError && err.code === 'AI_BUDGET_EXHAUSTED'
        ? err.message
        : 'The review couldn’t be written. Try again later.';
    await this.d.db
      .update(aiReviews)
      .set({ status: 'failed', error: message, updatedAt: sql`now()` })
      .where(and(eq(aiReviews.matchId, matchId), eq(aiReviews.userId, userId)));
  }
}
