import { LANGUAGE_TIME_FACTORS, type LanguageKey } from '@cb/contracts';

/** How each battle language is recognised in Judge0's /languages and how it is limited (plan §9.5). */
export const LANGUAGE_RULES: Record<
  LanguageKey,
  { pattern: RegExp; timeFactor: number; memOverheadKb: number; maxProcesses: number }
> = {
  cpp: {
    pattern: /^C\+\+ \((GCC|Clang)/i,
    timeFactor: LANGUAGE_TIME_FACTORS.cpp,
    memOverheadKb: 0,
    maxProcesses: 1,
  },
  // the JVM and Node use threads and a bigger baseline heap
  java: {
    pattern: /^Java \(OpenJDK/i,
    timeFactor: LANGUAGE_TIME_FACTORS.java,
    memOverheadKb: 65_536,
    maxProcesses: 60,
  },
  python: {
    pattern: /^Python \(3\./i,
    timeFactor: LANGUAGE_TIME_FACTORS.python,
    memOverheadKb: 16_384,
    maxProcesses: 1,
  },
  javascript: {
    pattern: /^JavaScript \(Node\.js/i,
    timeFactor: LANGUAGE_TIME_FACTORS.javascript,
    memOverheadKb: 32_768,
    maxProcesses: 60,
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
