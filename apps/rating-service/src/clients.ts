import { signInternalToken } from '@cb/auth';
import { profileSchema, type Player } from '@cb/contracts';
import { createHttpClient, type HttpClient } from '@cb/http-client';
import { z } from 'zod';

/** rating-service's view of user-service (an interface so tests plug in their own). */
export interface UserDirectory {
  players(ids: string[]): Promise<Map<string, Player>>;
  friendIds(userId: string): Promise<string[]>;
}

const BATCH = 100; // user-service's /internal/users/batch limit

/** Profiles cached for 30 s (plan §15), friend lists for 60 s. */
export class HttpUserDirectory implements UserDirectory {
  private readonly http: HttpClient;
  private token: { value: string; exp: number } | undefined;
  private readonly people = new Map<string, { at: number; player: Player }>();
  private readonly friends = new Map<string, { at: number; ids: string[] }>();

  constructor(private readonly o: { baseUrl: string; secret: string; service: string }) {
    this.http = createHttpClient({ name: 'user-service', baseUrl: o.baseUrl, timeoutMs: 3000, retries: 2 });
  }

  private async auth(): Promise<Record<string, string>> {
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.o.secret, this.o.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  async players(ids: string[]): Promise<Map<string, Player>> {
    const out = new Map<string, Player>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.people.get(id);
      if (hit && Date.now() - hit.at < 30_000) out.set(id, hit.player);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      const r = await this.http.request({
        path: `/internal/users/batch?ids=${missing.slice(i, i + BATCH).join(',')}`,
        headers: await this.auth(),
        schema: z.object({ items: z.array(profileSchema) }),
      });
      for (const p of r.data.items) {
        const player: Player = {
          id: p.id,
          username: p.username,
          fullname: p.fullname,
          avatarUrl: p.avatarUrl,
        };
        this.people.set(p.id, { at: Date.now(), player });
        out.set(p.id, player);
      }
    }
    if (this.people.size > 5000) this.people.clear();
    return out;
  }

  async friendIds(userId: string): Promise<string[]> {
    const hit = this.friends.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.ids;
    const r = await this.http.request({
      path: `/internal/users/${userId}/friend-ids`,
      headers: await this.auth(),
      schema: z.object({ ids: z.array(z.uuid()) }),
    });
    this.friends.set(userId, { at: Date.now(), ids: r.data.ids });
    if (this.friends.size > 5000) this.friends.clear();
    return r.data.ids;
  }
}
