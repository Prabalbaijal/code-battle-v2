import { v7 as uuidv7, validate, version } from 'uuid';

/** Time-ordered UUIDv7: good B-tree locality, sortable, usable as a cursor. */
export const newId = (): string => uuidv7();

export const isUuid = (s: string): boolean => validate(s);

/** Milliseconds since epoch encoded in a UUIDv7 (first 48 bits). */
export function timestampOfId(id: string): number {
  if (!validate(id) || version(id) !== 7) throw new Error(`not a uuidv7: ${id}`);
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
