import { signInternalToken } from '@cb/auth';
import {
  coinChargeResultSchema,
  internalSubmissionSchema,
  playerStatsSchema,
  publicProblemSchema,
  type CoinChargeRequest,
  type CoinChargeResult,
  type InternalSubmission,
  type PublicProblem,
  type Verdict,
} from '@cb/contracts';
import { conflict } from '@cb/errors';
import { createHttpClient, UpstreamError, type HttpClient } from '@cb/http-client';
import { z } from 'zod';

/** What ai-service needs from other services (interfaces, so tests plug in their own). */
export interface Upstreams {
  /** judge-service: submissions with code (internal). */
  submission(id: string): Promise<InternalSubmission | null>;
  submissions(q: {
    matchId?: string;
    problemId?: string;
    verdict?: Verdict;
    limit?: number;
  }): Promise<InternalSubmission[]>;
  /** problem-service: the public statement (never hidden tests). */
  problem(slug: string): Promise<PublicProblem | null>;
  /** rating-service: current coins, and charging for a hint. */
  coins(userId: string): Promise<number>;
  charge(c: CoinChargeRequest): Promise<CoinChargeResult>;
}

class ServiceToken {
  private token: { value: string; exp: number } | undefined;
  constructor(
    private readonly secret: string,
    private readonly service: string,
  ) {}
  async header(): Promise<Record<string, string>> {
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.secret, this.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }
}

const notFound = (err: unknown) => err instanceof UpstreamError && err.upstreamStatus === 404;

export class HttpUpstreams implements Upstreams {
  private readonly judge: HttpClient;
  private readonly problems: HttpClient;
  private readonly rating: HttpClient;
  private readonly token: ServiceToken;
  private readonly statements = new Map<string, { at: number; p: PublicProblem }>();

  constructor(o: {
    judgeUrl: string;
    problemUrl: string;
    ratingUrl: string;
    secret: string;
    service: string;
  }) {
    this.judge = createHttpClient({
      name: 'judge-service',
      baseUrl: o.judgeUrl,
      timeoutMs: 3000,
      retries: 2,
    });
    this.problems = createHttpClient({
      name: 'problem-service',
      baseUrl: o.problemUrl,
      timeoutMs: 3000,
      retries: 2,
    });
    // a charge must not be repeated blindly by the client: the ledger key makes our own retry safe
    this.rating = createHttpClient({
      name: 'rating-service',
      baseUrl: o.ratingUrl,
      timeoutMs: 3000,
      retries: 1,
    });
    this.token = new ServiceToken(o.secret, o.service);
  }

  async submission(id: string): Promise<InternalSubmission | null> {
    try {
      const r = await this.judge.request({
        path: `/internal/submissions/${id}`,
        headers: await this.token.header(),
        schema: internalSubmissionSchema,
      });
      return r.data;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async submissions(q: { matchId?: string; problemId?: string; verdict?: Verdict; limit?: number }) {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]): [string, string] => [k, String(v)]),
    );
    const r = await this.judge.request({
      path: `/internal/submissions?${qs}`,
      headers: await this.token.header(),
      schema: z.object({ items: z.array(internalSubmissionSchema) }),
    });
    return r.data.items;
  }

  /** Statements change rarely; cached for 5 minutes. */
  async problem(slug: string): Promise<PublicProblem | null> {
    const hit = this.statements.get(slug);
    if (hit && Date.now() - hit.at < 300_000) return hit.p;
    try {
      const r = await this.problems.request({
        path: `/api/v1/problems/${slug}`,
        schema: publicProblemSchema,
      });
      this.statements.set(slug, { at: Date.now(), p: r.data });
      if (this.statements.size > 500) this.statements.clear();
      return r.data;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  async coins(userId: string): Promise<number> {
    const r = await this.rating.request({ path: `/api/v1/stats/${userId}`, schema: playerStatsSchema });
    return r.data.coins;
  }

  async charge(c: CoinChargeRequest): Promise<CoinChargeResult> {
    try {
      const r = await this.rating.request({
        method: 'POST',
        path: '/internal/charges',
        headers: await this.token.header(),
        body: c,
        schema: coinChargeResultSchema,
        retry: true, // safe: one ledger row per (match, user, reason)
      });
      return r.data;
    } catch (err) {
      const code = (err as UpstreamError).body as { error?: { code?: string; message?: string } } | undefined;
      if (
        err instanceof UpstreamError &&
        err.upstreamStatus === 409 &&
        code?.error?.code === 'INSUFFICIENT_COINS'
      ) {
        throw conflict('INSUFFICIENT_COINS', code.error.message ?? 'Not enough coins');
      }
      throw err;
    }
  }
}
