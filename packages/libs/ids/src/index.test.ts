import { describe, expect, it } from 'vitest';
import { isUuid, newId, timestampOfId } from './index.js';

describe('ids', () => {
  it('generates time-ordered uuidv7', () => {
    const before = Date.now();
    const ids = Array.from({ length: 50 }, () => newId());
    expect(ids.every(isUuid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    const ts = timestampOfId(ids[0]!);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});
