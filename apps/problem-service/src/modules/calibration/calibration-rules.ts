import { LANGUAGE_KEYS, LANGUAGE_TIME_FACTORS, type LanguageKey } from '@cb/contracts';

/**
 * Time-limit calibration (plan §14.7, Kattis/Polygon style). Pure: problem-service collects the
 * reference runs from the judge, this decides the limits and whether the problem is publishable.
 */
export interface RefRun {
  referenceId: string;
  languageKey: LanguageKey;
  expectedVerdict: 'AC' | 'TLE' | 'WA';
  ordinal: number;
  verdict: string | null;
  cpuMs: number | null;
}

export interface CalibrationOutcome {
  limits: { ordinal: number; languageKey: LanguageKey; cpuLimitMs: number }[];
  problems: { code: string; message: string }[];
}

/** Hosted Judge0 is shared and noisy, so the margin is wider than the usual 2–2.5× (plan §14.7). */
export const MARGIN = 3;
export const MIN_LIMIT_MS = 1000;
const roundUp100 = (ms: number) => Math.ceil(ms / 100) * 100;

export function calibrate(input: {
  ordinals: number[];
  runs: RefRun[];
  instanceMaxMs: number;
}): CalibrationOutcome {
  const problems: CalibrationOutcome['problems'] = [];
  const add = (code: string, message: string) => problems.push({ code, message });
  const clamp = (ms: number) => Math.min(Math.max(roundUp100(ms), MIN_LIMIT_MS), input.instanceMaxMs);
  const acRuns = input.runs.filter((r) => r.expectedVerdict === 'AC');

  // 1. Accepted references must be accepted everywhere, with a measured time.
  for (const r of acRuns) {
    if (r.verdict !== 'AC' || r.cpuMs === null) {
      add(
        'REFERENCE_FAILED',
        `${r.languageKey} reference expected AC but got ${r.verdict ?? 'no result'} on file ${r.ordinal}`,
      );
    }
  }
  const slowest = (lang: LanguageKey, ordinal: number) => {
    const t = acRuns
      .filter(
        (r) => r.languageKey === lang && r.ordinal === ordinal && r.verdict === 'AC' && r.cpuMs !== null,
      )
      .map((r) => r.cpuMs!);
    return t.length ? Math.max(...t) : undefined;
  };

  // 2. Limits per file and language.
  const limits: CalibrationOutcome['limits'] = [];
  for (const ordinal of input.ordinals) {
    const cpp = slowest('cpp', ordinal);
    if (cpp === undefined) {
      // a C++ reference that ran but failed is already reported as REFERENCE_FAILED
      const failedCpp = acRuns.some((r) => r.languageKey === 'cpp' && r.ordinal === ordinal);
      if (failedCpp) continue;
      add('NO_CPP_BASELINE', `No accepted C++ time on file ${ordinal}; limits can't be derived`);
      continue;
    }
    for (const lang of LANGUAGE_KEYS) {
      const own = slowest(lang, ordinal);
      const base = own ?? cpp * LANGUAGE_TIME_FACTORS[lang];
      limits.push({ ordinal, languageKey: lang, cpuLimitMs: clamp(MARGIN * base) });
    }
  }
  const limitOf = (lang: LanguageKey, ordinal: number) =>
    limits.find((l) => l.languageKey === lang && l.ordinal === ordinal)?.cpuLimitMs;

  // 3. Accepted references must have headroom: at most limit / 1.5 (only fails when clamped).
  for (const r of acRuns) {
    const lim = limitOf(r.languageKey, r.ordinal);
    if (lim !== undefined && r.verdict === 'AC' && r.cpuMs !== null && r.cpuMs > lim / 1.5) {
      add(
        'REFERENCE_TOO_SLOW',
        `${r.languageKey} reference takes ${r.cpuMs} ms on file ${r.ordinal}; the limit ${lim} ms leaves too little headroom`,
      );
    }
  }

  // 4. Must-TLE solutions may not pass every file within 2 × limit (Kattis safety margin).
  // 5. Must-WA solutions must fail somewhere.
  const byRef = new Map<string, RefRun[]>();
  for (const r of input.runs) byRef.set(r.referenceId, [...(byRef.get(r.referenceId) ?? []), r]);
  for (const runs of byRef.values()) {
    const { expectedVerdict, languageKey } = runs[0]!;
    if (expectedVerdict === 'TLE') {
      const passesFast = runs.every((r) => {
        const lim = limitOf(languageKey, r.ordinal);
        return r.verdict === 'AC' && r.cpuMs !== null && lim !== undefined && r.cpuMs <= 2 * lim;
      });
      if (passesFast)
        add(
          'TLE_REFERENCE_TOO_FAST',
          `The must-TLE ${languageKey} solution passes every file within 2× the limit`,
        );
    }
    if (expectedVerdict === 'WA' && runs.every((r) => r.verdict === 'AC')) {
      add('WA_REFERENCE_PASSED', `The must-WA ${languageKey} solution was accepted on every file`);
    }
  }
  return { limits: problems.some((p) => p.code === 'NO_CPP_BASELINE') ? [] : limits, problems };
}
