/**
 * Packed test files (plan §14.2): one Judge0 run judges many cases.
 *
 * Input:  first token is `t` (number of cases), then the cases (problem-specific format).
 * Output: one line per case, or `lineCounts[i]` lines for case i when a case prints several lines.
 *
 * Pure functions; used by problem-service (validate uploads) and judge-service (attribute failures).
 */

export const PACK_KINDS = ['sample', 'small', 'large'] as const;
export type PackKind = (typeof PACK_KINDS)[number];

/** Input is sent in the Judge0 request body (plan §14.2). */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
/** Expected output must stay far below Judge0's output limit (large tests → small outputs). */
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_CASES_PER_PACK = 200_000;

export type PackProblem =
  | { code: 'EMPTY_INPUT' }
  | { code: 'BAD_CASE_COUNT'; token: string }
  | { code: 'INPUT_TOO_LARGE'; bytes: number }
  | { code: 'OUTPUT_TOO_LARGE'; bytes: number }
  | { code: 'LINE_COUNTS_LENGTH'; expected: number; got: number }
  | { code: 'BAD_LINE_COUNT'; index: number }
  | { code: 'OUTPUT_LINES'; expected: number; got: number };

export interface ValidPack {
  caseCount: number;
  /** Expected output split per case (each entry = that case's lines). */
  expected: string[][];
  inputBytes: number;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Lines of program/expected output: CRLF-tolerant, trailing blank lines ignored. */
export function outputLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines.at(-1)!.trim() === '') lines.pop();
  return lines;
}

/** Split output lines into cases using per-case line counts (default 1 each). */
export function splitCases(
  lines: string[],
  caseCount: number,
  lineCounts?: readonly number[] | null,
): string[][] {
  const cases: string[][] = [];
  let at = 0;
  for (let i = 0; i < caseCount; i++) {
    const n = lineCounts ? lineCounts[i]! : 1;
    cases.push(lines.slice(at, at + n));
    at += n;
  }
  return cases;
}

/** Validate an uploaded pack; returns the parsed pack or every problem found. */
export function validatePack(
  input: string,
  output: string,
  lineCounts?: readonly number[] | null,
): { ok: true; pack: ValidPack } | { ok: false; problems: PackProblem[] } {
  const problems: PackProblem[] = [];
  const inputBytes = bytes(input);
  if (inputBytes > MAX_INPUT_BYTES) problems.push({ code: 'INPUT_TOO_LARGE', bytes: inputBytes });
  const outBytes = bytes(output);
  if (outBytes > MAX_OUTPUT_BYTES) problems.push({ code: 'OUTPUT_TOO_LARGE', bytes: outBytes });

  const first = input.trimStart().split(/\s+/, 1)[0] ?? '';
  if (!first) return { ok: false, problems: [...problems, { code: 'EMPTY_INPUT' }] };
  const t = /^\d+$/.test(first) ? Number(first) : NaN;
  if (!Number.isSafeInteger(t) || t < 1 || t > MAX_CASES_PER_PACK) {
    return { ok: false, problems: [...problems, { code: 'BAD_CASE_COUNT', token: first.slice(0, 20) }] };
  }

  if (lineCounts) {
    if (lineCounts.length !== t)
      problems.push({ code: 'LINE_COUNTS_LENGTH', expected: t, got: lineCounts.length });
    lineCounts.forEach((n, index) => {
      if (!Number.isInteger(n) || n < 1) problems.push({ code: 'BAD_LINE_COUNT', index });
    });
  }
  const lines = outputLines(output);
  const expectedLines = lineCounts ? lineCounts.reduce((a, b) => a + b, 0) : t;
  if (lines.length !== expectedLines)
    problems.push({ code: 'OUTPUT_LINES', expected: expectedLines, got: lines.length });

  if (problems.length) return { ok: false, problems };
  return { ok: true, pack: { caseCount: t, expected: splitCases(lines, t, lineCounts), inputBytes } };
}

/** Human-readable message for a pack problem (admin UI, API errors). */
export function describePackProblem(p: PackProblem): string {
  switch (p.code) {
    case 'EMPTY_INPUT':
      return 'Input is empty';
    case 'BAD_CASE_COUNT':
      return `Input must start with the number of test cases t (got "${p.token}")`;
    case 'INPUT_TOO_LARGE':
      return `Input is ${p.bytes} bytes; the limit is ${MAX_INPUT_BYTES}`;
    case 'OUTPUT_TOO_LARGE':
      return `Expected output is ${p.bytes} bytes; keep it under ${MAX_OUTPUT_BYTES}`;
    case 'LINE_COUNTS_LENGTH':
      return `outputCaseLineCounts has ${p.got} entries but there are ${p.expected} cases`;
    case 'BAD_LINE_COUNT':
      return `outputCaseLineCounts[${p.index}] must be a positive integer`;
    case 'OUTPUT_LINES':
      return `Expected output has ${p.got} lines but the cases need ${p.expected}`;
  }
}
