import { PACK_KINDS, PROBLEM_LIMITS } from '@cb/contracts';
import { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, PACK_KINDS as CORE_PACK_KINDS } from '@cb/judge-core';
import { describe, expect, it } from 'vitest';

// The admin UI checks file sizes with @cb/contracts before uploading; judge-core is the authority.
describe('shared problem limits', () => {
  it('match judge-core', () => {
    expect([PROBLEM_LIMITS.testInputBytes, PROBLEM_LIMITS.testOutputBytes]).toEqual([
      MAX_INPUT_BYTES,
      MAX_OUTPUT_BYTES,
    ]);
    expect(PACK_KINDS).toEqual(CORE_PACK_KINDS);
  });
});
