import { describe, expect, it } from 'vitest';
import { registerBodySchema, usernameSchema } from './auth.js';

describe('usernameSchema', () => {
  it('accepts 3–20 letters, digits and underscores', () => {
    for (const ok of ['abc', 'Player_1', 'a'.repeat(20)])
      expect(usernameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['ab', 'a'.repeat(21), 'has space', 'dash-ed', 'émile']) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('refuses reserved names case-insensitively (they collide with /users/search etc.)', () => {
    for (const r of ['search', 'SEARCH', 'Admin', 'batch'])
      expect(usernameSchema.safeParse(r).success, r).toBe(false);
  });

  it('normalises email to lower case', () => {
    const r = registerBodySchema.parse({
      username: 'abc',
      fullname: 'A',
      email: ' A@B.IO ',
      password: 'Sup3r-secret',
    });
    expect(r.email).toBe('a@b.io');
  });
});
