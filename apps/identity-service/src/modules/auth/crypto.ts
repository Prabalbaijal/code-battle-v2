import { hash, parseOptions, verify, type Algorithm } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

/** OWASP Argon2id baseline (plan §16): m=19 MiB, t=2, p=1. `2` = Algorithm.Argon2id (a const enum). */
export const ARGON2_PARAMS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type PasswordAlgo = 'argon2id' | 'bcrypt';

/** Hash used to equalise timing when the account doesn't exist. */
let dummyHash: Promise<string> | undefined;

export const passwords = {
  hash: (password: string): Promise<string> => hash(password, ARGON2_PARAMS),

  /** Never throws: a malformed stored hash is simply "wrong password". */
  async verify(stored: string, algo: PasswordAlgo, password: string): Promise<boolean> {
    try {
      return algo === 'bcrypt' ? await bcrypt.compare(password, stored) : await verify(stored, password);
    } catch {
      return false;
    }
  },

  /** True for migrated bcrypt hashes and Argon2 hashes weaker than the current params. */
  needsRehash(stored: string, algo: PasswordAlgo): boolean {
    if (algo !== 'argon2id') return true;
    try {
      const o = parseOptions(stored);
      return (
        o.algorithm !== ARGON2_PARAMS.algorithm ||
        o.memoryCost < ARGON2_PARAMS.memoryCost ||
        o.timeCost < ARGON2_PARAMS.timeCost
      );
    } catch {
      return true;
    }
  },

  /** Spend the same time as a real verify so "no such user" isn't faster than "wrong password". */
  async burn(password: string): Promise<void> {
    dummyHash ??= hash('timing-equaliser-not-a-real-password', ARGON2_PARAMS);
    await verify(await dummyHash, password).catch(() => false);
  },
};

/** 256-bit random token, base64url (43 chars). Only its sha256 is stored. */
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
