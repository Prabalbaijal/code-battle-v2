import type { Profile } from '@cb/contracts';
import type { ProfileRow } from '../../db/schema.js';

export const toProfile = (p: ProfileRow): Profile => ({
  id: p.userId,
  username: p.username,
  fullname: p.fullname,
  avatarUrl: p.avatarUrl,
  bio: p.bio,
  createdAt: p.createdAt.toISOString(),
});
