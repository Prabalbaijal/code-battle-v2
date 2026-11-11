import { signInternalToken } from '@cb/auth';
import { profileSchema, type Player } from '@cb/contracts';
import { createHttpClient, type HttpClient } from '@cb/http-client';
import { z } from 'zod';

/** Who someone's friends are, and how to show a player. user-service is the source. */
export interface Directory {
  friendIds(userId: string): Promise<string[]>;
  players(ids: string[]): Promise<Map<string, Player>>;
  /** A friendship changed: every node consumes the event and drops its cached list. */
  forgetFriends(userId: string): void;
}

/**
 * In-memory caches per node. Friend lists are invalidated by `user.friendship.changed.v1` (every
 * node sees every event), and expire after 5 minutes anyway.
 */
export class HttpDirectory implements Directory {
  private readonly http: HttpClient;
  private readonly friends = new Map<string, { at: number; ids: string[] }>();
  private readonly people = new Map<string, { at: number; player: Player }>();
  private token: { value: string; exp: number } | undefined;

  constructor(private readonly o: { baseUrl: string; secret: string; service: string }) {
    this.http = createHttpClient({ name: 'user-service', baseUrl: o.baseUrl, timeoutMs: 3000, retries: 1 });
  }

  private async auth() {
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.o.secret, this.o.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  async friendIds(userId: string): Promise<string[]> {
    const hit = this.friends.get(userId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ids;
    const r = await this.http.request({
      path: `/internal/users/${userId}/friend-ids`,
      headers: await this.auth(),
      schema: z.object({ ids: z.array(z.uuid()) }),
    });
    this.friends.set(userId, { at: Date.now(), ids: r.data.ids });
    if (this.friends.size > 20_000) this.friends.clear();
    return r.data.ids;
  }

  forgetFriends(userId: string): void {
    this.friends.delete(userId);
  }

  async players(ids: string[]): Promise<Map<string, Player>> {
    const out = new Map<string, Player>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.people.get(id);
      if (hit && Date.now() - hit.at < 60_000) out.set(id, hit.player);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 100) {
      const r = await this.http.request({
        path: `/internal/users/batch?ids=${missing.slice(i, i + 100).join(',')}`,
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
    if (this.people.size > 20_000) this.people.clear();
    return out;
  }
}
