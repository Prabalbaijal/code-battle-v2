import type { AdminProblem } from '@cb/contracts';
import { describe, expect, it } from 'vitest';
import { toCreateBody, toUpdateBody, toValues } from './problem-form';

const problem = {
  slug: 'pair-sums',
  title: 'Pair sums',
  difficulty: 'Medium',
  statementMd: 'Print $a+b$.',
  inputFormatMd: 'in',
  outputFormatMd: 'out',
  constraints: ['$1 \\le t$', '$|a| \\le 10^9$'],
  examples: [{ input: '1\n1 2', output: '3' }],
  tags: ['math', 'implementation'],
  memoryLimitKb: 262_144,
  outputLimitKb: 1024,
  checkerType: 'tokens',
  floatEps: null,
} as unknown as AdminProblem;

describe('problem form mapping', () => {
  it('turns a problem into form values and back without changes', () => {
    const v = toValues(problem);
    expect(v).toMatchObject({
      memoryMb: 256,
      constraints: '$1 \\le t$\n$|a| \\le 10^9$',
      tags: 'math, implementation',
    });
    expect(toCreateBody(v)).toEqual({
      slug: 'pair-sums',
      title: 'Pair sums',
      difficulty: 'Medium',
      statementMd: 'Print $a+b$.',
      inputFormatMd: 'in',
      outputFormatMd: 'out',
      constraints: problem.constraints,
      examples: [{ input: '1\n1 2', output: '3' }], // empty explanation is left out
      tags: problem.tags,
      memoryLimitKb: 262_144,
      outputLimitKb: 1024,
      checkerType: 'tokens',
      floatEps: null,
    });
  });

  it('an edit sends only the changed fields (limit fields would void calibration)', () => {
    const v = { ...toValues(problem), title: '  Pair sums II ', tags: ' Math ,, Greedy ' };
    expect(toUpdateBody(v, new Set(['title', 'tags']))).toEqual({
      title: 'Pair sums II',
      tags: ['math', 'greedy'],
    });
    expect(toUpdateBody({ ...v, memoryMb: 128 }, new Set(['memoryMb']))).toEqual({ memoryLimitKb: 131_072 });
  });

  it('the float checker carries its epsilon; other checkers clear it', () => {
    const v = toValues(problem);
    expect(toUpdateBody({ ...v, checkerType: 'float', floatEps: '1e-6' }, new Set(['checkerType']))).toEqual({
      checkerType: 'float',
      floatEps: 0.000001,
    });
    expect(toUpdateBody({ ...v, checkerType: 'exact', floatEps: '' }, new Set(['checkerType']))).toEqual({
      checkerType: 'exact',
      floatEps: null,
    });
  });

  it('a new problem starts with one empty example and the default limits', () => {
    expect(toValues()).toMatchObject({
      examples: [{ input: '', output: '', explanation: '' }],
      memoryMb: 192,
      outputLimitKb: 1024,
      checkerType: 'tokens',
    });
  });
});
