import { describe, expect, it } from 'vitest';
import { pollIndex } from './judging.service.js';

describe('pollIndex', () => {
  it('maps time since a stage started to the poll schedule; past the end means give up', () => {
    const delays = [1000, 2000, 4000];
    expect([0, 999, 1000, 2999, 3000, 6999, 7000].map((ms) => pollIndex(ms, delays))).toEqual([
      0, 0, 1, 1, 2, 2, 3,
    ]);
  });
});
