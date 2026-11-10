import { describe, expect, it } from 'vitest';
import { checkCase, checkPack } from './checkers.js';
import { describePackProblem, MAX_INPUT_BYTES, outputLines, validatePack } from './test-pack.js';

describe('validatePack', () => {
  it('parses t and splits expected output per case (default one line each)', () => {
    const r = validatePack('3\n1 2\n3 4\n5 6\n', '3\n7\n11\n');
    expect(r).toEqual({ ok: true, pack: { caseCount: 3, expected: [['3'], ['7'], ['11']], inputBytes: 14 } });
  });

  it('supports multi-line answers via line counts, CRLF and trailing blank lines', () => {
    const r = validatePack('2\na\nb\n', 'x\r\ny\r\nz\r\n\r\n', [2, 1]);
    expect(r.ok && r.pack.expected).toEqual([['x', 'y'], ['z']]);
  });

  it('reports every problem with a readable message', () => {
    const cases: [string, string, number[] | undefined, string][] = [
      ['', '1', undefined, 'EMPTY_INPUT'],
      ['abc\n', '1', undefined, 'BAD_CASE_COUNT'],
      ['0\n', '', undefined, 'BAD_CASE_COUNT'],
      ['2\n', '1\n', undefined, 'OUTPUT_LINES'],
      ['2\n', '1\n2\n3\n', [1], 'LINE_COUNTS_LENGTH'],
      ['2\n', '1\n2\n', [1, 0], 'BAD_LINE_COUNT'],
    ];
    for (const [input, output, counts, code] of cases) {
      const r = validatePack(input, output, counts);
      expect(r.ok, code).toBe(false);
      if (!r.ok) {
        expect(r.problems.map((p) => p.code)).toContain(code);
        expect(describePackProblem(r.problems[0]!).length).toBeGreaterThan(5);
      }
    }
    const big = validatePack(`1\n${'x'.repeat(MAX_INPUT_BYTES)}`, '1');
    expect(!big.ok && big.problems.map((p) => p.code)).toContain('INPUT_TOO_LARGE');
  });

  it('outputLines ignores trailing blank lines only', () => {
    expect(outputLines('a\n\nb\n\n\n')).toEqual(['a', '', 'b']);
  });
});

describe('checkers', () => {
  const expected = [['3'], ['7'], ['11']];

  it('tokens: whitespace layout does not matter; failures point at the case', () => {
    expect(checkPack(expected, '3\n7\n11\n', { type: 'tokens' })).toEqual({ ok: true });
    expect(checkPack(expected, '3 7   11', { type: 'tokens' })).toEqual({ ok: true }); // one line
    expect(checkPack(expected, '3\n8\n11', { type: 'tokens' })).toMatchObject({ ok: false, failedCase: 2 });
    expect(checkPack(expected, '3\n7', { type: 'tokens' })).toMatchObject({
      ok: false,
      failedCase: 3,
      reason: 'no output for this case',
    });
    expect(checkPack(expected, '', { type: 'tokens' })).toMatchObject({ failedCase: 1 });
    expect(checkPack(expected, '3 7 11 12', { type: 'tokens' })).toMatchObject({
      ok: false,
      failedCase: 3,
      reason: '1 extra token(s)',
    });
  });

  it('tokens: multi-token answers', () => {
    const exp = [['1 2 3'], ['4 5']];
    expect(checkPack(exp, '1 2\n3\n4 5', { type: 'tokens' })).toEqual({ ok: true });
    expect(checkPack(exp, '1 2 3 4 6', { type: 'tokens' })).toMatchObject({ failedCase: 2 });
  });

  it('float: absolute or relative epsilon', () => {
    const exp = [['0.333333'], ['1000000.0']];
    expect(checkPack(exp, '0.3333334 1000000.5', { type: 'float', eps: 1e-6 })).toEqual({ ok: true });
    expect(checkPack(exp, '0.3334 1000000', { type: 'float', eps: 1e-6 })).toMatchObject({ failedCase: 1 });
    expect(checkCase(['NaN'], ['NaN'], { type: 'float' })).toEqual({ ok: true });
    expect(checkCase(['abc'], ['abd'], { type: 'float' }).ok).toBe(false);
    expect(checkCase(['1e3'], ['1000'], { type: 'float' })).toEqual({ ok: true });
  });

  it('exact: lines must match except trailing spaces', () => {
    const exp = [['Hello World'], ['Yes']];
    expect(checkPack(exp, 'Hello World  \nYes\n', { type: 'exact' })).toEqual({ ok: true });
    expect(checkPack(exp, 'Hello  World\nYes', { type: 'exact' })).toMatchObject({ failedCase: 1 });
    expect(checkPack(exp, 'Hello World\nYes\nextra', { type: 'exact' })).toMatchObject({
      failedCase: 2,
      reason: '1 extra output line(s)',
    });
    expect(checkPack([['a', 'b'], ['c']], 'a\nb\nc', { type: 'exact' }, [2, 1])).toEqual({ ok: true });
    expect(checkPack([['a', 'b'], ['c']], 'a\nc\nb', { type: 'exact' }, [2, 1])).toMatchObject({
      failedCase: 1,
    });
  });
});
