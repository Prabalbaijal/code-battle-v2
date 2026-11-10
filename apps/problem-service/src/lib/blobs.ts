import type { Executor } from '@cb/db';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { blobs } from '../db/schema.js';

/** Storage for test packs and reference code. Content-addressed, so writes are idempotent. */
export interface BlobStore {
  put(
    ex: Executor,
    content: string,
    contentType?: string,
  ): Promise<{ key: string; sha256: string; size: number }>;
  get(ex: Executor, key: string): Promise<Buffer | undefined>;
}

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Blobs in Postgres (plan decision log: R2 would need a payment method on the account). */
export const postgresBlobStore: BlobStore = {
  async put(ex, content, contentType = 'text/plain; charset=utf-8') {
    const bytes = Buffer.from(content, 'utf8');
    const sha256 = sha256Hex(bytes);
    const key = `sha256/${sha256}`;
    await ex.insert(blobs).values({ key, bytes, size: bytes.length, contentType }).onConflictDoNothing();
    return { key, sha256, size: bytes.length };
  },
  async get(ex, key) {
    const [b] = await ex.select({ bytes: blobs.bytes }).from(blobs).where(eq(blobs.key, key));
    return b?.bytes;
  },
};
