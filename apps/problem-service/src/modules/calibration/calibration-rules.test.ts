import { describe, expect, it } from 'vitest';
import { calibrate, type RefRun } from './calibration-rules.js';

const run = (
  ref: string,
  lang: RefRun['languageKey'],
  expected: RefRun['expectedVerdict'],
  ordinal: number,
  verdict: string,
  cpuMs: number,
): RefRun => ({
  referenceId: ref,
  languageKey: lang,
  expectedVerdict: expected,
  ordinal,
  verdict,
  cpuMs,
});
const limit = (o: ReturnType<typeof calibrate>, lang: string, ordinal: number) =>
  o.limits.find((l) => l.languageKey === lang && l.ordinal === ordinal)?.cpuLimitMs;

describe('calibrate', () => {
  const cppAc = [
    run('c', 'cpp', 'AC', 1, 'AC', 10),
    run('c', 'cpp', 'AC', 2, 'AC', 120),
    run('c', 'cpp', 'AC', 3, 'AC', 450),
  ];
  const brute = [
    run('b', 'cpp', 'TLE', 1, 'AC', 10),
    run('b', 'cpp', 'TLE', 2, 'AC', 300),
    run('b', 'cpp', 'TLE', 3, 'TLE', 15000),
  ];

  it('3× the slowest accepted time, rounded up to 100 ms, at least 1 s; others via factors + startup', () => {
    const o = calibrate({ ordinals: [1, 2, 3], runs: [...cppAc, ...brute], instanceMaxMs: 15000 });
    expect(o.problems).toEqual([]);
    expect([limit(o, 'cpp', 1), limit(o, 'cpp', 2), limit(o, 'cpp', 3)]).toEqual([1000, 1000, 1400]); // 30→1000, 360→1000, 1350→1400
    expect(limit(o, 'python', 3)).toBe(5600); // 3 × 450 × 3 (factor) + 1.5 × 1000 (startup) = 5550
    expect(limit(o, 'java', 3)).toBe(2900); // 3 × 450 × 2 + 1.5 × 100 = 2850
    // Node needs ~1 s before user code runs, so even a 10 ms C++ file can't get the 1 s minimum
    expect(limit(o, 'javascript', 1)).toBe(1700); // 3 × 10 × 1.5 + 1.5 × 1050 = 1620
    expect(o.limits).toHaveLength(12);
  });

  it('a language with its own accepted reference uses its own time', () => {
    const py = [
      run('p', 'python', 'AC', 1, 'AC', 50),
      run('p', 'python', 'AC', 2, 'AC', 200),
      run('p', 'python', 'AC', 3, 'AC', 900),
    ];
    const o = calibrate({ ordinals: [1, 2, 3], runs: [...cppAc, ...py, ...brute], instanceMaxMs: 15000 });
    expect(limit(o, 'python', 3)).toBe(2700); // 900 × 3: its own time already includes startup
  });

  it('flags accepted references that fail, and those too close to a clamped limit', () => {
    const bad = calibrate({
      ordinals: [1, 2],
      runs: [run('c', 'cpp', 'AC', 1, 'AC', 10), run('c', 'cpp', 'AC', 2, 'WA', 10), ...brute.slice(0, 2)],
      instanceMaxMs: 15000,
    });
    expect(bad.problems.map((p) => p.code)).toEqual(['REFERENCE_FAILED']); // not also NO_CPP_BASELINE
    const slow = calibrate({
      ordinals: [1],
      runs: [run('c', 'cpp', 'AC', 1, 'AC', 12000)],
      instanceMaxMs: 15000,
    });
    expect(slow.problems.map((p) => p.code)).toEqual(['REFERENCE_TOO_SLOW']); // 3 × 12000 is clamped to 15000, and 15000 / 1.5 = 10000 < 12000
  });

  it('a must-TLE solution passing everything within 2× the limit blocks publishing', () => {
    const fastBrute = [
      run('b', 'cpp', 'TLE', 1, 'AC', 10),
      run('b', 'cpp', 'TLE', 2, 'AC', 300),
      run('b', 'cpp', 'TLE', 3, 'AC', 2500),
    ];
    const o = calibrate({ ordinals: [1, 2, 3], runs: [...cppAc, ...fastBrute], instanceMaxMs: 15000 });
    expect(o.problems.map((p) => p.code)).toEqual(['TLE_REFERENCE_TOO_FAST']); // 2500 ≤ 2 × 1400
    const slowBrute = [...fastBrute.slice(0, 2), run('b', 'cpp', 'TLE', 3, 'AC', 2900)];
    expect(
      calibrate({ ordinals: [1, 2, 3], runs: [...cppAc, ...slowBrute], instanceMaxMs: 15000 }).problems,
    ).toEqual([]);
  });

  it('a must-WA solution must fail somewhere; no C++ baseline means no limits', () => {
    const wa = [run('w', 'java', 'WA', 1, 'AC', 10), run('w', 'java', 'WA', 2, 'AC', 10)];
    expect(
      calibrate({ ordinals: [1, 2], runs: [...cppAc.slice(0, 2), ...wa], instanceMaxMs: 15000 }).problems.map(
        (p) => p.code,
      ),
    ).toEqual(['WA_REFERENCE_PASSED']);
    const none = calibrate({
      ordinals: [1],
      runs: [run('p', 'python', 'AC', 1, 'AC', 10)],
      instanceMaxMs: 15000,
    });
    expect(none).toEqual({ limits: [], problems: [expect.objectContaining({ code: 'NO_CPP_BASELINE' })] });
  });
});
