import { hash } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, newOpaqueToken, passwords, sha256 } from './crypto.js';

describe('passwords', () => {
  it('hashes with Argon2id at the OWASP baseline and verifies', async () => {
    const h = await passwords.hash('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.verify(h, 'argon2id', 'correct horse battery')).toBe(true);
    expect(await passwords.verify(h, 'argon2id', 'wrong')).toBe(false);
    expect(passwords.needsRehash(h, 'argon2id')).toBe(false);
  });

  it('verifies migrated bcrypt hashes and flags them for rehash', async () => {
    const h = await bcrypt.hash('legacy-pass', 4);
    expect(await passwords.verify(h, 'bcrypt', 'legacy-pass')).toBe(true);
    expect(await passwords.verify(h, 'bcrypt', 'nope')).toBe(false);
    expect(passwords.needsRehash(h, 'bcrypt')).toBe(true);
  });

  it('flags weaker Argon2 params and never throws on garbage', async () => {
    const weak = await hash('x', { ...ARGON2_PARAMS, memoryCost: 4096, timeCost: 1 });
    expect(passwords.needsRehash(weak, 'argon2id')).toBe(true);
    expect(await passwords.verify('not-a-hash', 'argon2id', 'x')).toBe(false);
    expect(passwords.needsRehash('not-a-hash', 'argon2id')).toBe(true);
    await expect(passwords.burn('anything')).resolves.toBeUndefined();
  });
});

describe('opaque tokens', () => {
  it('are 256-bit base64url and hash to 32 bytes', () => {
    const t = newOpaqueToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newOpaqueToken()).not.toBe(t);
    expect(sha256(t)).toHaveLength(32);
  });
});
