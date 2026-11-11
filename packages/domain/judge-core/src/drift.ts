/**
 * Drift tracking (plan §14.8): the hosted judge's hardware can change under us. A weekly check runs
 * fixed benchmark programs; when they get more than 20% slower or faster than when limits were
 * calibrated, every CPU limit is multiplied by a factor (like Codeforces doubling limits after a
 * hardware change).
 */

/** CPU ms per benchmark, e.g. `{ cpp: 310, python: 1820 }`. */
export type DriftSample = Record<string, number>;

/** The first checks define the baseline; later ones are compared with it. */
export const BASELINE_CHECKS = 3;
export const DRIFT_THRESHOLD = 0.2;
export const MIN_FACTOR = 0.5;
export const MAX_FACTOR = 2;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface DriftOutcome {
  /** Per-benchmark baseline, or null while there are fewer than BASELINE_CHECKS earlier checks. */
  baseline: DriftSample | null;
  /** current / baseline (median over benchmarks), or null without a baseline. */
  ratio: number | null;
  /** What CPU limits are multiplied by: 1 unless drift exceeds the threshold. */
  factor: number;
}

/**
 * @param history earlier successful checks, oldest first (the baseline is fixed: limits were
 *   calibrated against that hardware, so a later slow period must not become the new normal)
 * @param current this check
 */
export function driftOutcome(history: DriftSample[], current: DriftSample): DriftOutcome {
  if (history.length < BASELINE_CHECKS) return { baseline: null, ratio: null, factor: 1 };
  const first = history.slice(0, BASELINE_CHECKS);
  const baseline: DriftSample = {};
  const ratios: number[] = [];
  for (const bench of Object.keys(current)) {
    const values = first.map((h) => h[bench]).filter((v): v is number => typeof v === 'number' && v > 0);
    if (values.length < BASELINE_CHECKS || !(current[bench]! > 0)) continue;
    baseline[bench] = median(values);
    ratios.push(current[bench]! / baseline[bench]!);
  }
  if (!ratios.length) return { baseline: null, ratio: null, factor: 1 };
  const ratio = Math.round(median(ratios) * 100) / 100;
  const factor =
    Math.abs(ratio - 1) > DRIFT_THRESHOLD ? Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, ratio)) : 1;
  return { baseline, ratio, factor };
}
