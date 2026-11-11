import { signInternalToken } from '@cb/auth';
import { participationSchema, type Participation } from '@cb/contracts';
import { createHttpClient, UpstreamError, type HttpClient } from '@cb/http-client';

/** Plan §11.3: may this user submit in this match right now? battle-service is the authority. */
export interface MatchParticipation {
  get(matchId: string, userId: string): Promise<Participation | undefined>;
}

/**
 * Asks battle-service, caching the answer briefly: a match's players and problem never change,
 * and the status only moves forward, so a stale "in progress" is caught by `endsAt` and by the
 * battle side ignoring submissions after the end.
 */
export class HttpMatchParticipation implements MatchParticipation {
  private readonly http: HttpClient;
  private readonly cache = new Map<string, { at: number; value: Participation | undefined }>();
  private token: { value: string; exp: number } | undefined;

  constructor(private readonly o: { baseUrl: string; secret: string; service: string; ttlMs?: number }) {
    this.http = createHttpClient({ name: 'battle-service', baseUrl: o.baseUrl, timeoutMs: 2000, retries: 1 });
  }

  async get(matchId: string, userId: string): Promise<Participation | undefined> {
    const key = `${matchId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.o.ttlMs ?? 15_000)) return hit.value;
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.o.secret, this.o.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    let value: Participation | undefined;
    try {
      const r = await this.http.request({
        path: `/internal/matches/${matchId}/participation?userId=${userId}`,
        headers: { authorization: `Bearer ${this.token.value}` },
        schema: participationSchema,
      });
      value = r.data;
    } catch (err) {
      if (!(err instanceof UpstreamError && err.upstreamStatus === 404)) throw err;
    }
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 10_000) this.cache.clear();
    return value;
  }
}
