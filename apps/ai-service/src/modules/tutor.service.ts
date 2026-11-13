import type { TutorFrame, TutorRequest } from '@cb/contracts';
import type { Db } from '@cb/db';
import { AppError, notFound } from '@cb/errors';
import { sql } from 'drizzle-orm';
import type { Upstreams } from '../clients.js';
import { aiMatches } from '../db/schema.js';
import type { ModelGateway } from '../llm/gateway.js';
import { fence, render, type Prompt } from '../llm/prompts.js';
import type { ChatMessage } from '../llm/provider.js';
import type { KnowledgeService } from './knowledge.service.js';
import { clip } from './problem-text.js';
import type { ReadModel } from './readmodel.service.js';

const forbidden = (message: string) => new AppError('AI_NOT_ALLOWED', 403, message);

export interface PreparedAnswer {
  /** First frame (citations), then the streamed text. */
  frames: AsyncGenerator<TutorFrame>;
}

/**
 * The RAG tutor (plan §22.2 #3): hybrid retrieval over DSA notes (and statements of problems the
 * player has played), then a streamed answer with inline citations [n]. Off during a battle, so it
 * can't be used to solve the running problem.
 */
export class TutorService {
  constructor(
    private readonly d: {
      db: Db;
      gateway: ModelGateway;
      upstreams: Upstreams;
      readModel: ReadModel;
      knowledge: KnowledgeService;
      prompt: Prompt;
    },
  ) {}

  /**
   * Everything that can fail with a proper HTTP error happens here, before the stream starts:
   * eligibility, the submission, retrieval and the budget reservation (the first `next()`).
   */
  async prepare(userId: string, req: TutorRequest, signal?: AbortSignal): Promise<PreparedAnswer> {
    if (await this.d.readModel.activeMatch(userId)) {
      throw forbidden('The tutor is off while you’re in a match. Good luck!');
    }

    let submissionBlock = '';
    let searchExtra = '';
    if (req.submissionId) {
      const s = await this.d.upstreams.submission(req.submissionId);
      if (!s || s.userId !== userId) throw notFound('Submission');
      const m = s.matchId ? await this.d.readModel.match(s.matchId) : undefined;
      if (m?.status === 'in_progress') throw forbidden('Ask about this submission after the match.');
      const problem = await this.d.readModel.problem(s.problemId);
      const failed = s.failedFile ? ` on the ${s.failedFile.kind} tests, case ${s.failedCase ?? '?'}` : '';
      submissionBlock = [
        '',
        `The student shares their submission to "${problem?.slug ?? 'a problem'}": verdict ${s.verdict ?? 'not judged'}${failed}` +
          `${s.maxCpuMs != null ? `, ${s.maxCpuMs} ms` : ''}${s.message ? `\nJudge message: ${fence(s.message.slice(0, 1000))}` : ''}.`,
        `Language: ${s.languageKey}`,
        '<user_code>',
        fence(clip(s.code)),
        '</user_code>',
        '',
      ].join('\n');
      searchExtra = ` ${s.verdict ?? ''} ${problem?.tags.join(' ') ?? ''}`;
    }

    const played = await this.d.db
      .selectDistinct({ id: aiMatches.problemId })
      .from(aiMatches)
      .where(sql`${userId}::uuid = any(${aiMatches.userIds}) and ${aiMatches.status} <> 'in_progress'`);
    const passages = await this.d.knowledge.search(req.question + searchExtra, {
      allowedProblemIds: played.map((p) => p.id),
    });
    const context = passages.length
      ? passages.map((p) => `[${p.n}] ${p.title} — ${p.heading}\n${fence(p.content)}`).join('\n\n')
      : '(no matching passages)';

    const messages: ChatMessage[] = [
      { role: 'system', content: this.d.prompt.system },
      ...req.history.map((h) => ({ role: h.role, content: fence(h.content) })),
      {
        role: 'user',
        content: render(this.d.prompt.user, {
          context,
          submission: submissionBlock,
          question: fence(req.question),
        }),
      },
    ];
    const text = this.d.gateway.stream(
      {
        feature: 'tutor',
        tier: 'strong',
        userId,
        promptVersion: this.d.prompt.version,
        maxTokens: 1200,
        messages,
      },
      signal,
    );
    // start the call now: budget and provider errors surface as HTTP errors, not mid-stream
    const first = await text.next();

    async function* frames(): AsyncGenerator<TutorFrame> {
      yield { type: 'citations', items: passages.map((p) => p.citation) };
      if (!first.done) yield { type: 'delta', text: first.value };
      for await (const delta of text) yield { type: 'delta', text: delta };
      yield { type: 'done' };
    }
    return { frames: frames() };
  }
}
