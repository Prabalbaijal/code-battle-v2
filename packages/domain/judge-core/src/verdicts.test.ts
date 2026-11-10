import { describe, expect, it } from 'vitest';
import {
  classifyRun,
  decide,
  J0,
  judgeFile,
  requestLimits,
  type FileOutcome,
  type FileSpec,
  type RunResult,
} from './verdicts.js';

const instance = { maxCpuSec: 15, maxWallSec: 20, maxMemKb: 256_000, maxStackKb: 128_000, maxFileKb: 4096 };
const limits = requestLimits({
  cpuLimitMs: 2000,
  memoryLimitKb: 196_608,
  outputLimitKb: 1024,
  lang: { memOverheadKb: 0, maxProcesses: 1 },
  instance,
});
const lim = { cpuSec: 2, wallSec: limits.wall_time_limit, memKb: limits.memory_limit };
const run = (over: Partial<RunResult> = {}): RunResult => ({
  statusId: J0.ACCEPTED,
  time: 0.1,
  wallTime: 0.2,
  memoryKb: 2048,
  stdout: '3\n7\n',
  stderr: null,
  compileOutput: null,
  message: null,
  ...over,
});
const file: FileSpec = { ordinal: 2, kind: 'small', expected: [['3'], ['7']], lineCounts: null };
const checker = { type: 'tokens' as const };

describe('requestLimits', () => {
  it('follows the plan table and respects instance maximums', () => {
    expect(limits).toEqual({
      cpu_time_limit: 2,
      cpu_extra_time: 0.5,
      wall_time_limit: 7,
      memory_limit: 196_608,
      stack_limit: 128_000,
      max_processes_and_or_threads: 1,
      enable_per_process_and_thread_time_limit: false,
      max_file_size: 1024,
      number_of_runs: 1,
    });
    const big = requestLimits({
      cpuLimitMs: 30_000,
      memoryLimitKb: 250_000,
      outputLimitKb: 9999,
      lang: { memOverheadKb: 20_000, maxProcesses: 30 },
      instance,
    });
    expect(big).toMatchObject({
      cpu_time_limit: 15,
      cpu_extra_time: 1.5,
      wall_time_limit: 20,
      memory_limit: 256_000,
      max_file_size: 4096,
    });
  });
});

describe('classifyRun', () => {
  const cases: [Partial<RunResult>, string][] = [
    [{}, 'CHECK'],
    [{ statusId: J0.INTERNAL_ERROR }, 'IE'],
    [{ statusId: J0.EXEC_FORMAT_ERROR }, 'IE'],
    [{ statusId: J0.CE }, 'CE'],
    [{ statusId: J0.TLE, time: 2.4 }, 'TLE'],
    [{ time: 2.1 }, 'TLE'], // status 3 but over our limit (extra time grace)
    [{ wallTime: 30 }, 'TLE'], // sleeping/blocked program
    [{ statusId: J0.SIGXFSZ }, 'OLE'],
    [{ statusId: J0.SIGSEGV }, 'RE'],
    [{ statusId: J0.NZEC, stderr: 'Exception in thread "main" java.lang.OutOfMemoryError' }, 'MLE'],
    [
      { statusId: J0.SIGABRT, stderr: "terminate called after throwing an instance of 'std::bad_alloc'" },
      'MLE',
    ],
    [{ statusId: J0.SIGSEGV, memoryKb: 195_000 }, 'MLE'], // ≥ 95% of the limit
    [{ statusId: J0.WRONG_ANSWER }, 'IE'], // impossible: we never send expected_output
  ];
  for (const [r, v] of cases) {
    it(`${JSON.stringify(r)} → ${v}`, () => expect(classifyRun(run(r), lim)).toBe(v));
  }
  it('null time is never treated as 0, and in-progress runs are refused', () => {
    expect(classifyRun(run({ time: null }), lim)).toBe('CHECK');
    expect(() => classifyRun(run({ statusId: J0.PROCESSING }), lim)).toThrow();
  });
});

describe('judgeFile', () => {
  it('AC, or WA on the exact case, with time and memory', () => {
    expect(judgeFile(run(), file, limits, checker, 1)).toMatchObject({
      verdict: 'AC',
      cpuMs: 100,
      memKb: 2048,
    });
    expect(judgeFile(run({ stdout: '3\n8\n' }), file, limits, checker, 1)).toMatchObject({
      verdict: 'WA',
      failedCase: 2,
    });
  });
  it('flags near-miss TLEs (≤ 1.2 × limit) but not real ones', () => {
    expect(judgeFile(run({ statusId: J0.TLE, time: 2.3 }), file, limits, checker, 1)).toMatchObject({
      verdict: 'TLE',
      nearMiss: true,
    });
    expect(judgeFile(run({ statusId: J0.TLE, time: 2.5 }), file, limits, checker, 1)).toMatchObject({
      verdict: 'TLE',
      nearMiss: false,
    });
    expect(
      judgeFile(run({ statusId: J0.TLE, time: null, wallTime: 9 }), file, limits, checker, 1).nearMiss,
    ).toBe(false);
  });
  it('keeps compile output (trimmed) for CE and stderr for RE', () => {
    const ce = judgeFile(run({ statusId: J0.CE, compileOutput: 'x'.repeat(5000) }), file, limits, checker, 1);
    expect(ce.message!.length).toBe(2049);
    expect(
      judgeFile(run({ statusId: J0.SIGFPE, stderr: 'Floating point exception' }), file, limits, checker, 1),
    ).toMatchObject({
      verdict: 'RE',
      message: 'Floating point exception',
    });
  });
});

describe('decide', () => {
  const ac = (ordinal: number, over: Partial<FileOutcome> = {}): FileOutcome => ({
    ordinal,
    kind: ordinal === 1 ? 'sample' : ordinal === 2 ? 'small' : 'large',
    attempt: 1,
    verdict: 'AC',
    failedCase: null,
    cpuMs: 100 * ordinal,
    memKb: 1000 * ordinal,
    nearMiss: false,
    message: null,
    ...over,
  });
  const stage = (outcomes: (FileOutcome | undefined)[], hasNextStage = false, previous: FileOutcome[] = []) =>
    decide({
      files: outcomes.map((o, i) => ({ ordinal: o?.ordinal ?? i + 1, outcome: o })),
      previous,
      hasNextStage,
    });

  it('waits for every file of the stage', () => {
    expect(stage([ac(1), undefined])).toEqual({ kind: 'wait' });
  });
  it('stage 1 all AC → stage 2; last stage all AC → AC with max time/memory over all stages', () => {
    expect(stage([ac(1), ac(2)], true)).toEqual({ kind: 'next-stage' });
    expect(stage([ac(3)], false, [ac(1), ac(2)])).toEqual({
      kind: 'final',
      verdict: 'AC',
      failedOrdinal: null,
      failedCase: null,
      maxCpuMs: 300,
      maxMemKb: 3000,
      message: null,
    });
  });
  it('CE anywhere stops judging, even if an earlier file failed differently', () => {
    expect(
      stage([ac(1, { verdict: 'WA', failedCase: 1 }), ac(2, { verdict: 'CE', message: 'err' })]),
    ).toMatchObject({
      kind: 'final',
      verdict: 'CE',
      message: 'err',
    });
  });
  it('the first non-AC file in order decides', () => {
    expect(stage([ac(1), ac(2, { verdict: 'WA', failedCase: 37 })], true)).toMatchObject({
      verdict: 'WA',
      failedOrdinal: 2,
      failedCase: 37,
    });
    expect(stage([ac(1, { verdict: 'RE' }), ac(2, { verdict: 'WA', failedCase: 1 })])).toMatchObject({
      verdict: 'RE',
      failedOrdinal: 1,
    });
  });
  it('near-miss TLE and IE get exactly one rerun', () => {
    expect(stage([ac(3, { verdict: 'TLE', nearMiss: true })])).toEqual({
      kind: 'rerun',
      ordinal: 3,
      reason: 'near-miss',
    });
    expect(stage([ac(3, { verdict: 'TLE', nearMiss: true, attempt: 2 })])).toMatchObject({
      kind: 'final',
      verdict: 'TLE',
    });
    expect(stage([ac(3, { verdict: 'TLE', nearMiss: false })])).toMatchObject({
      kind: 'final',
      verdict: 'TLE',
    });
    expect(stage([ac(1, { verdict: 'IE' })])).toEqual({
      kind: 'rerun',
      ordinal: 1,
      reason: 'internal-error',
    });
    expect(stage([ac(1, { verdict: 'IE', attempt: 2 })])).toMatchObject({ kind: 'final', verdict: 'IE' });
  });
});
