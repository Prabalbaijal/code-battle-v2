import {
  userEvents,
  type AvatarUploadSignature,
  type EventData,
  type identityEvents,
  type Relationship,
  type UpdateProfileBody,
} from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, badRequest, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { z } from 'zod';
import type { ProfileRow } from '../../db/schema.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { friendsRepository } from '../friends/friends.repository.js';
import type { AvatarUploads } from './avatar.js';
import { profileRepository as repo } from './profile.repository.js';

export interface ProfileServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  avatars: AvatarUploads;
  afterCommit?: () => void;
}

const searchCursor = z.object({ k: z.string().max(40) });
const FUZZY_MIN_LENGTH = 3;

/** Profiles: replica from identity events, public view, search, edit, avatar uploads. */
export class ProfileService {
  constructor(private readonly d: ProfileServiceDeps) {}

  /** Kafka handler effect (runs inside the inbox transaction). */
  async createFromRegistration(tx: Tx, e: EventData<typeof identityEvents.userRegisteredV1>): Promise<void> {
    await repo.insertFromRegistration(tx, {
      userId: e.userId,
      username: e.username,
      fullname: e.fullname,
      createdAt: new Date(e.registeredAt),
    });
  }

  /** The profile is created asynchronously from identity's event; a brand-new user may see 404 briefly. */
  async me(userId: string): Promise<ProfileRow> {
    const p = await repo.findById(this.d.db, userId);
    if (!p) throw notFound('Profile');
    return p;
  }

  async byUsername(
    username: string,
    viewerId?: string,
  ): Promise<{ profile: ProfileRow; relationship?: Relationship }> {
    const profile = await repo.findByUsername(this.d.db, username);
    if (!profile) throw notFound('User');
    if (!viewerId) return { profile };
    if (viewerId === profile.userId) return { profile, relationship: 'self' };
    return {
      profile,
      relationship: await friendsRepository.relationship(this.d.db, viewerId, profile.userId),
    };
  }

  async update(userId: string, patch: UpdateProfileBody): Promise<ProfileRow> {
    if (patch.avatarUrl && !this.d.avatars.isAllowedUrl(patch.avatarUrl, userId)) {
      throw badRequest('avatarUrl must be your own upload from the avatar upload endpoint');
    }
    const updated = await withTransaction(this.d.db, async (tx) => {
      const p = await repo.update(tx, userId, patch);
      if (!p) throw notFound('Profile');
      await this.d.outbox.add(tx, userEvents.profileUpdatedV1, {
        key: userId,
        data: {
          userId,
          username: p.username,
          fullname: p.fullname,
          avatarUrl: p.avatarUrl,
          bio: p.bio,
          updatedAt: p.updatedAt.toISOString(),
        },
      });
      return p;
    });
    this.d.afterCommit?.();
    return updated;
  }

  /**
   * Prefix search with keyset pagination. If the first page is empty and the query is long enough,
   * fall back to fuzzy (trigram) matches, e.g. "prabla" finds "prabal".
   */
  async search(q: string, cursor: string | undefined, limit: number) {
    const after = decodeCursor(searchCursor, cursor)?.k;
    const rows = await repo.searchPrefix(this.d.db, q, after, limit + 1);
    const items = rows.slice(0, limit);
    if (!items.length && !after && q.length >= FUZZY_MIN_LENGTH) {
      return { items: await repo.searchFuzzy(this.d.db, q, limit), nextCursor: null, fuzzy: true };
    }
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ k: last.username.toLowerCase() }) : null,
      fuzzy: false,
    };
  }

  async batch(ids: string[]): Promise<ProfileRow[]> {
    return repo.findManyByIds(this.d.db, [...new Set(ids)]);
  }

  avatarUploadSignature(userId: string): AvatarUploadSignature {
    const sig = this.d.avatars.signature(userId);
    if (!sig)
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'Avatar uploads are not configured', { expose: true });
    return sig;
  }
}
