import { describe, expect, it } from 'vitest';
import { stableStringify } from './index.js';

describe('stableStringify', () => {
  it('is independent of key order and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }], c: undefined })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify(null)).toBe('null');
  });
});
