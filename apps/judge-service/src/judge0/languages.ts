import { LANGUAGE_TIME_FACTORS, type LanguageKey } from '@cb/contracts';

/**
 * Judge0's own default for `max_processes_and_or_threads`. Judge0 CE starts every program through
 * a shell wrapper (`run.sh`, `conda_init` for Python) that forks, so a lower limit makes each run
 * fail with "fork: Resource temporarily unavailable" (found with real Judge0; fake-judge0 now
 * mimics it). Fork bombs stay inside the isolate sandbox and its time and memory limits.
 */
export const JUDGE0_PROCESSES = 60;

/** How each battle language is recognised in Judge0's /languages and how it is limited (plan §9.5). */
export const LANGUAGE_RULES: Record<
  LanguageKey,
  { pattern: RegExp; timeFactor: number; memOverheadKb: number; maxProcesses: number }
> = {
  cpp: {
    pattern: /^C\+\+ \((GCC|Clang)/i,
    timeFactor: LANGUAGE_TIME_FACTORS.cpp,
    memOverheadKb: 0,
    maxProcesses: JUDGE0_PROCESSES,
  },
  // the JVM and Node need a bigger baseline heap
  java: {
    pattern: /^Java \(OpenJDK/i,
    timeFactor: LANGUAGE_TIME_FACTORS.java,
    memOverheadKb: 65_536,
    maxProcesses: JUDGE0_PROCESSES,
  },
  python: {
    pattern: /^Python \(3\./i,
    timeFactor: LANGUAGE_TIME_FACTORS.python,
    memOverheadKb: 16_384,
    maxProcesses: JUDGE0_PROCESSES,
  },
  javascript: {
    pattern: /^JavaScript \(Node\.js/i,
    timeFactor: LANGUAGE_TIME_FACTORS.javascript,
    memOverheadKb: 32_768,
    maxProcesses: JUDGE0_PROCESSES,
  },
};

/** Version numbers inside the name, e.g. "Python (3.11.2)" → [3, 11, 2], for "pick the newest". */
const versionOf = (name: string) => (name.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

export interface ResolvedLanguage {
  key: LanguageKey;
  judge0Id: number;
  name: string;
}

/** Resolve each language to the newest matching Judge0 runtime; languages with no match are missing. */
export function resolveLanguages(available: { id: number; name: string }[]): ResolvedLanguage[] {
  const out: ResolvedLanguage[] = [];
  for (const [key, rule] of Object.entries(LANGUAGE_RULES) as [
    LanguageKey,
    (typeof LANGUAGE_RULES)[LanguageKey],
  ][]) {
    const matches = available.filter((l) => rule.pattern.test(l.name));
    if (!matches.length) continue;
    const best = matches.reduce((a, b) => (newer(versionOf(b.name), versionOf(a.name)) ? b : a));
    out.push({ key, judge0Id: best.id, name: best.name });
  }
  return out;
}
