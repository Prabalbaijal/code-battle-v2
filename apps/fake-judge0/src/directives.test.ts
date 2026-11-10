import { describe, expect, it } from 'vitest';
import { parseDirectives, runProgram } from './directives.js';

describe('directives', () => {
  it('parses timePerKb and wrongCase', () => {
    expect(parseDirectives('// @fake program=sum-cases timePerKb=0.5 wrongCase=2')).toEqual({
      program: 'sum-cases',
      timePerKb: 0.5,
      wrongCase: 2,
    });
  });

  it('sum-cases answers every case, or one wrong case on request', () => {
    const stdin = '3\n1 2\n3 4\n5 6\n';
    expect(runProgram('sum-cases', stdin)).toBe('3\n7\n11\n');
    expect(runProgram('sum-cases', stdin, 2)).toBe('3\n8\n11\n');
  });
});
