import { signInternalToken } from '@cb/auth';
import { profileSchema, type Player } from '@cb/contracts';
import { createHttpClient, type HttpClient } from '@cb/http-client';
import { z } from 'zod';

/** Names for notifications (an interface so tests plug in their own). */
export interface UserDirectory {
  players(ids: string[]): Promise<Map<string, Player>>;
}

/** user-service `/internal/users/batch`, cached for a minute. */
export class HttpUserDirectory implements UserDirectory {
  private readonly http: HttpClient;
  private token: { value: string; exp: number } | undefined;
  private readonly cache = new Map<string, { at: number; player: Player }>();

  constructor(private readonly o: { baseUrl: string; secret: string; service: string }) {
    this.http = createHttpClient({ name: 'user-service', baseUrl: o.baseUrl, timeoutMs: 3000, retries: 2 });
  }

  async players(ids: string[]): Promise<Map<string, Player>> {
    const out = new Map<string, Player>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.cache.get(id);
      if (hit && Date.now() - hit.at < 60_000) out.set(id, hit.player);
      else missing.push(id);
    }
    if (missing.length) {
      if (!this.token || this.token.exp < Date.now() + 5000) {
        this.token = {
          value: await signInternalToken(this.o.secret, this.o.service, 60),
          exp: Date.now() + 60_000,
        };
      }
      const r = await this.http.request({
        path: `/internal/users/batch?ids=${missing.join(',')}`,
        headers: { authorization: `Bearer ${this.token.value}` },
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
