import { badRequest } from '@cb/errors';
import type { z } from 'zod';

/** Opaque keyset cursors: base64url(JSON). Clients pass them back unchanged. */
export const encodeCursor = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor<S extends z.ZodType>(
  schema: S,
  cursor: string | undefined,
): z.infer<S> | undefined {
  if (!cursor) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('invalid cursor');
  }
}
