import { describe, expect, it } from 'vitest';
import { assertValidJobId } from './queue.js';

describe('assertValidJobId', () => {
  it('accepts business keys and rejects colons/empty', () => {
    expect(() => assertValidJobId('match-timeout-0190f5b2-6c1e-7cc2-9a59-3b0f6f3c2a11')).not.toThrow();
    expect(() => assertValidJobId('match-timeout:abc')).toThrow();
    expect(() => assertValidJobId('')).toThrow();
  });
});
