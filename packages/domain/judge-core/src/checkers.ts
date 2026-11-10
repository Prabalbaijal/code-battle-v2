import { outputLines, splitCases } from './test-pack.js';

/**
 * Output checkers (plan §9.3 `checker_type`):
 * - tokens: whitespace-insensitive token comparison (the default, like most judges)
 * - float:  tokens, but numbers within `eps` (absolute or relative) are equal
 * - exact:  line by line, ignoring only trailing spaces and trailing blank lines
 */
export const CHECKER_TYPES = ['tokens', 'float', 'exact'] as const;
export type CheckerType = (typeof CHECKER_TYPES)[number];

export interface CheckerSpec {
  type: CheckerType;
  /** float checker only; default 1e-6 */
  eps?: number | null;
}

export type CaseResult = { ok: true } | { ok: false; reason: string };

export type PackResult =
  | { ok: true }
  /** 1-based case number, as shown to users ("Wrong answer on case 37"). */
  | { ok: false; failedCase: number; reason: string };

const tokens = (lines: string[]) => lines.join('\n').split(/\s+/).filter(Boolean);
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function floatEqual(a: string, b: string, eps: number): boolean {
  if (a === b) return true;
  if (!NUM.test(a) || !NUM.test(b)) return false;
  const x = Number(a);
  const y = Number(b);
  const diff = Math.abs(x - y);
  return diff <= eps || diff <= eps * Math.max(Math.abs(x), Math.abs(y));
}

/** Compare one case's output lines with the expected lines. */
export function checkCase(expected: string[], actual: string[], spec: CheckerSpec): CaseResult {
  if (spec.type === 'exact') {
    const e = expected.map((l) => l.trimEnd());
    const a = actual.map((l) => l.trimEnd());
    for (let i = 0; i < Math.max(e.length, a.length); i++) {
      if (e[i] !== a[i]) return { ok: false, reason: `line ${i + 1} differs` };
    }
    return { ok: true };
  }
  const e = tokens(expected);
  const a = tokens(actual);
  if (a.length !== e.length) return { ok: false, reason: `expected ${e.length} tokens, got ${a.length}` };
  const eps = spec.eps ?? 1e-6;
  for (let i = 0; i < e.length; i++) {
    const same = spec.type === 'float' ? floatEqual(e[i]!, a[i]!, eps) : e[i] === a[i];
    if (!same) return { ok: false, reason: `token ${i + 1} differs` };
  }
  return { ok: true };
}

/**
 * Check a whole pack's stdout against the expected per-case lines, and point at the first failing
 * case (1-based).
 * - tokens/float: the stream of tokens is compared; each case consumes as many tokens as its
 *   expected answer has, so line layout doesn't matter (answers on one line still pass).
 * - exact: the output is split with the same per-case line counts as the expected output.
 */
export function checkPack(
  expected: string[][],
  stdout: string,
  spec: CheckerSpec,
  lineCounts?: readonly number[] | null,
): PackResult {
  if (spec.type === 'exact') {
    const lines = outputLines(stdout);
    const actual = splitCases(lines, expected.length, lineCounts);
    for (let i = 0; i < expected.length; i++) {
      const r = checkCase(expected[i]!, actual[i]!, spec);
      if (!r.ok) return { ok: false, failedCase: i + 1, reason: r.reason };
    }
    const extra = lines.length - expected.reduce((n, c) => n + c.length, 0);
    return extra > 0
      ? { ok: false, failedCase: expected.length, reason: `${extra} extra output line(s)` }
      : { ok: true };
  }

  const got = tokens([stdout]);
  const eps = spec.eps ?? 1e-6;
  let at = 0;
  for (let i = 0; i < expected.length; i++) {
    const want = tokens(expected[i]!);
    if (at + want.length > got.length) {
      return {
        ok: false,
        failedCase: i + 1,
        reason: at >= got.length ? 'no output for this case' : 'output ended early',
      };
    }
    for (let j = 0; j < want.length; j++) {
      const a = got[at + j]!;
      const same = spec.type === 'float' ? floatEqual(want[j]!, a, eps) : want[j] === a;
      if (!same) return { ok: false, failedCase: i + 1, reason: `token ${j + 1} differs` };
    }
    at += want.length;
  }
  return at < got.length
    ? { ok: false, failedCase: expected.length, reason: `${got.length - at} extra token(s)` }
    : { ok: true };
}
