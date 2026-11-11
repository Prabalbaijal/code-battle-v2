import { JUDGE_LEVELS } from '@cb/contracts';
import { DEGRADATION_LEVELS } from '@cb/judge-core';
import { describe, expect, it } from 'vitest';

describe('degradation levels', () => {
  it('the API contract lists the same ladder as judge-core', () => {
    expect([...JUDGE_LEVELS]).toEqual([...DEGRADATION_LEVELS]);
  });
});
