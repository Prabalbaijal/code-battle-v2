import { signInternalToken } from '@cb/auth';
import {
  capacitySchema,
  profileSchema,
  selectionResultSchema,
  type Capacity,
  type Player,
  type SelectionResult,
} from '@cb/contracts';
import { createHttpClient, UpstreamError, type HttpClient } from '@cb/http-client';
import { z } from 'zod';

/**
 * battle-service's view of other services. Interfaces so tests (and Phase 3 part B, realtime
 * presence) can plug in their own.
 */
export interface ProblemSelector {
  /** Idempotent by matchId (plan §11.2). Throws SelectionError when no problem can be picked. */
  select(matchId: string, userIds: string[]): Promise<SelectionResult>;
}
export interface JudgeCapacity {
  capacity(): Promise<Capacity>;
}
export interface UserDirectory {
  players(ids: string[]): Promise<Map<string, Player>>;
}
/** Plan §11.1: challenges go to online players only. Realtime provides it (Phase 3 part B). */
export interface PresenceSource {
  isOnline(userId: string): Promise<boolean>;
}

/** No problem left for this pair (or problem-service refused): the start is compensated. */
export class SelectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SelectionError';
  }
}

const upstreamCode = (err: UpstreamError) =>
  (err.body as { error?: { code?: string } } | undefined)?.error?.code ?? 'UPSTREAM_ERROR';

class InternalHttp {
  readonly http: HttpClient;
  private token: { value: string; exp: number } | undefined;

  constructor(
    name: string,
    baseUrl: string,
    private readonly secret: string,
    private readonly service: string,
    timeoutMs: number,
  ) {
    this.http = createHttpClient({ name, baseUrl, timeoutMs, retries: 2 });
  }

  async auth(): Promise<Record<string, string>> {
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.secret, this.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }
}

export class HttpProblemSelector implements ProblemSelector {
  private readonly c: InternalHttp;
  constructor(o: { baseUrl: string; secret: string; service: string }) {
    // plan §11.2: 2 s timeout, 2 retries with jitter, circuit breaker (http-client defaults)
    this.c = new InternalHttp('problem-service', o.baseUrl, o.secret, o.service, 2000);
  }

  async select(matchId: string, userIds: string[]): Promise<SelectionResult> {
    try {
      const r = await this.c.http.request({
        method: 'POST',
        path: '/internal/selections',
        body: { matchId, userIds },
        headers: await this.c.auth(),
        schema: selectionResultSchema,
        retry: true, // idempotent by matchId
      });
      return r.data;
    } catch (err) {
      if (err instanceof UpstreamError && err.upstreamStatus !== undefined && err.upstreamStatus < 500) {
        throw new SelectionError(upstreamCode(err), err.message);
      }
      throw new SelectionError('PROBLEM_SERVICE_UNAVAILABLE', (err as Error).message);
    }
  }
}

export class HttpJudgeCapacity implements JudgeCapacity {
  private readonly c: InternalHttp;
  constructor(o: { baseUrl: string; secret: string; service: string }) {
    this.c = new InternalHttp('judge-service', o.baseUrl, o.secret, o.service, 2000);
  }

  async capacity(): Promise<Capacity> {
    const r = await this.c.http.request({
      path: '/internal/capacity',
      headers: await this.c.auth(),
      schema: capacitySchema,
    });
    return r.data;
  }
}

/** Profiles from user-service, cached briefly (usernames rarely change; avatars may). */
export class HttpUserDirectory implements UserDirectory {
  private readonly c: InternalHttp;
  private readonly cache = new Map<string, { at: number; player: Player }>();

  constructor(o: { baseUrl: string; secret: string; service: string; ttlMs?: number }) {
    this.c = new InternalHttp('user-service', o.baseUrl, o.secret, o.service, 3000);
    this.ttlMs = o.ttlMs ?? 60_000;
  }
  private readonly ttlMs: number;

  async players(ids: string[]): Promise<Map<string, Player>> {
    const out = new Map<string, Player>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.cache.get(id);
      if (hit && Date.now() - hit.at < this.ttlMs) out.set(id, hit.player);
      else missing.push(id);
    }
    if (missing.length) {
      const r = await this.c.http.request({
        path: `/internal/users/batch?ids=${missing.join(',')}`,
        headers: await this.c.auth(),
        schema: z.object({ items: z.array(profileSchema) }),
      });
      for (const p of r.data.items) {
        const player: Player = {
          id: p.id,
          username: p.username,
          fullname: p.fullname,
          avatarUrl: p.avatarUrl,
        };
        this.cache.set(p.id, { at: Date.now(), player });
        out.set(p.id, player);
      }
      if (this.cache.size > 5000) this.cache.clear();
    }
    return out;
  }
}

/** Until realtime presence exists (Phase 3 part B), everyone counts as online. */
export const everyoneOnline: PresenceSource = { isOnline: async () => true };
