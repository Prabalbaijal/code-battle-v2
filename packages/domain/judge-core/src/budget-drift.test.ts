import { describe, expect, it } from 'vitest';
import { degradationLevel, isAtLeast, requestsFor } from './budget.js';
import { driftOutcome } from './drift.js';

describe('budget', () => {
  it('counts Judge0 requests, not files (a batch is one call)', () => {
    expect([requestsFor(0, 20), requestsFor(1, 20), requestsFor(3, 20), requestsFor(21, 20)]).toEqual([
      0, 1, 1, 2,
    ]);
  });

  it('degrades step by step as the day budget runs out', () => {
    const at = (remaining: number) => degradationLevel(remaining, 100);
    expect([at(100), at(30), at(29), at(15), at(14), at(5), at(4), at(0)]).toEqual([
      'normal',
      'normal',
      'no_custom_input',
      'no_custom_input',
      'runs_throttled',
      'runs_throttled',
      'no_new_matches',
      'no_new_matches',
    ]);
    expect(isAtLeast('runs_throttled', 'no_custom_input')).toBe(true);
    expect(isAtLeast('normal', 'no_custom_input')).toBe(false);
  });
});

describe('drift', () => {
  const base = [
    { cpp: 300, python: 1800 },
    { cpp: 320, python: 1750 },
    { cpp: 310, python: 1820 },
  ];

  it('has no factor until three checks set the baseline', () => {
    expect(driftOutcome(base.slice(0, 2), { cpp: 900, python: 5000 })).toEqual({
      baseline: null,
      ratio: null,
      factor: 1,
    });
  });

  it('ignores noise within ±20% and scales limits beyond it, capped to 0.5–2', () => {
    expect(driftOutcome(base, { cpp: 350, python: 1900 })).toMatchObject({ factor: 1, ratio: 1.09 }); // (1.13 + 1.06) / 2
    const slow = driftOutcome(base, { cpp: 465, python: 2700 }); // 1.5× and 1.5×
    expect(slow).toMatchObject({ baseline: { cpp: 310, python: 1800 }, ratio: 1.5, factor: 1.5 });
    expect(driftOutcome(base, { cpp: 1500, python: 9000 }).factor).toBe(2);
    expect(driftOutcome(base, { cpp: 100, python: 500 }).factor).toBe(0.5);
  });

  it('keeps the first checks as the baseline (a slow period never becomes normal)', () => {
    const history = [...base, { cpp: 620, python: 3600 }, { cpp: 620, python: 3600 }];
    expect(driftOutcome(history, { cpp: 620, python: 3600 }).factor).toBe(2);
  });
});
