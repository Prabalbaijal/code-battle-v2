import { checkPack, type CheckerSpec } from './checkers.js';
import type { PackKind } from './test-pack.js';

/**
 * Verdicts and judging decisions (plan §14.3–14.5). Pure: the judge-service feeds Judge0 results in
 * and acts on the decision (rerun a file, start stage 2, or finalize).
 */
export const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'IE'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Judge0 status ids (https://ce.judge0.com/statuses). */
export const J0 = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TLE: 5,
  CE: 6,
  SIGSEGV: 7,
  SIGXFSZ: 8,
  SIGFPE: 9,
  SIGABRT: 10,
  NZEC: 11,
  RE_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
} as const;

export const isFinalStatus = (id: number) => id !== J0.IN_QUEUE && id !== J0.PROCESSING;

/** Normalised Judge0 result (seconds as numbers; base64 already decoded). */
export interface RunResult {
  statusId: number;
  /** CPU seconds; null when Judge0 didn't report it (never treated as 0). */
  time: number | null;
  wallTime: number | null;
  memoryKb: number | null;
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  message: string | null;
}

export interface InstanceLimits {
  maxCpuSec: number;
  maxWallSec: number;
  maxMemKb: number;
  maxStackKb: number;
  maxFileKb: number;
}

export interface LanguageProfile {
  memOverheadKb: number;
  maxProcesses: number;
}

/** What we ask Judge0 for one file run (plan §14.5 table). */
export interface RequestLimits {
  cpu_time_limit: number;
  cpu_extra_time: number;
  wall_time_limit: number;
  memory_limit: number;
  stack_limit: number;
  max_processes_and_or_threads: number;
  enable_per_process_and_thread_time_limit: false;
  max_file_size: number;
  number_of_runs: 1;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function requestLimits(input: {
  cpuLimitMs: number;
  memoryLimitKb: number;
  outputLimitKb: number;
  lang: LanguageProfile;
  instance: InstanceLimits;
}): RequestLimits {
  const { instance: max } = input;
  const cpu = Math.min(input.cpuLimitMs / 1000, max.maxCpuSec);
  const mem = Math.min(input.memoryLimitKb + input.lang.memOverheadKb, max.maxMemKb);
  return {
    cpu_time_limit: round1(cpu),
    cpu_extra_time: round1(Math.max(0.5, 0.1 * cpu)),
    wall_time_limit: round1(Math.min(3 * cpu + 1, max.maxWallSec)),
    memory_limit: mem,
    stack_limit: Math.min(mem, max.maxStackKb),
    max_processes_and_or_threads: input.lang.maxProcesses,
    enable_per_process_and_thread_time_limit: false,
    max_file_size: Math.min(input.outputLimitKb, max.maxFileKb),
    number_of_runs: 1,
  };
}

const OOM = /OutOfMemoryError|MemoryError|std::bad_alloc|heap out of memory|Cannot allocate memory/i;

/** Judge0 status → verdict, or CHECK when the program exited cleanly and output must be checked. */
export function classifyRun(
  r: RunResult,
  lim: { cpuSec: number; wallSec: number; memKb: number },
): Verdict | 'CHECK' {
  const id = r.statusId;
  if (!isFinalStatus(id)) throw new Error('classifyRun called on a run that is still queued/processing');
  if (id === J0.INTERNAL_ERROR || id === J0.EXEC_FORMAT_ERROR) return 'IE';
  if (id === J0.CE) return 'CE';
  if (
    id === J0.TLE ||
    (r.time !== null && r.time > lim.cpuSec) ||
    (r.wallTime !== null && r.wallTime > lim.wallSec)
  ) {
    return 'TLE';
  }
  if (id === J0.SIGXFSZ) return 'OLE';
  if (id >= J0.SIGSEGV && id <= J0.RE_OTHER) {
    const memHit = r.memoryKb !== null && r.memoryKb >= 0.95 * lim.memKb;
    return memHit || OOM.test(r.stderr ?? '') ? 'MLE' : 'RE';
  }
  // We never send expected_output, so 3 (Accepted) only means "exited 0": our checker decides.
  // 4 (Wrong Answer) can't come back for the same reason; treat anything else as an internal error.
  if (id === J0.ACCEPTED) return 'CHECK';
  return 'IE';
}

export interface FileSpec {
  ordinal: number;
  kind: PackKind;
  expected: string[][];
  lineCounts: readonly number[] | null;
}

export interface FileOutcome {
  ordinal: number;
  kind: PackKind;
  attempt: number;
  verdict: Verdict;
  failedCase: number | null;
  cpuMs: number | null;
  memKb: number | null;
  /** TLE with CPU in (limit, 1.2 × limit]: shared hardware is noisy, worth one rerun (plan §14.4). */
  nearMiss: boolean;
  message: string | null;
}

const trim = (s: string | null, max: number) => (s && s.length > max ? `${s.slice(0, max)}…` : s);

/** Classify one Judge0 run and, if it ran cleanly, check its output case by case. */
export function judgeFile(
  r: RunResult,
  file: FileSpec,
  limits: RequestLimits,
  checker: CheckerSpec,
  attempt: number,
): FileOutcome {
  const lim = { cpuSec: limits.cpu_time_limit, wallSec: limits.wall_time_limit, memKb: limits.memory_limit };
  const base = {
    ordinal: file.ordinal,
    kind: file.kind,
    attempt,
    cpuMs: r.time === null ? null : Math.round(r.time * 1000),
    memKb: r.memoryKb,
    failedCase: null,
    nearMiss: false,
  };
  const v = classifyRun(r, lim);
  if (v === 'CHECK') {
    const c = checkPack(file.expected, r.stdout ?? '', checker, file.lineCounts);
    return c.ok
      ? { ...base, verdict: 'AC', message: null }
      : { ...base, verdict: 'WA', failedCase: c.failedCase, message: c.reason };
  }
  if (v === 'TLE') {
    const nearMiss = r.time !== null && r.time > lim.cpuSec && r.time <= lim.cpuSec * 1.2;
    return { ...base, verdict: 'TLE', nearMiss, message: null };
  }
  if (v === 'CE') return { ...base, verdict: 'CE', message: trim(r.compileOutput, 2048) };
  if (v === 'RE' || v === 'MLE') return { ...base, verdict: v, message: trim(r.stderr ?? r.message, 1024) };
  return { ...base, verdict: v, message: trim(r.message, 512) };
}

export type Decision =
  | { kind: 'wait' }
  | { kind: 'rerun'; ordinal: number; reason: 'near-miss' | 'internal-error' }
  | { kind: 'next-stage' }
  | {
      kind: 'final';
      verdict: Verdict;
      failedOrdinal: number | null;
      failedCase: number | null;
      maxCpuMs: number | null;
      maxMemKb: number | null;
      message: string | null;
    };

export interface StageState {
  /** Files of the current stage, in order, with their latest outcome (undefined = still running). */
  files: { ordinal: number; outcome: FileOutcome | undefined }[];
  /** Outcomes of earlier stages (all AC, or we wouldn't be here). */
  previous: FileOutcome[];
  hasNextStage: boolean;
}

const maxOf = (xs: (number | null)[]) => {
  const ns = xs.filter((x): x is number => x !== null);
  return ns.length ? Math.max(...ns) : null;
};

/**
 * What to do once results arrive (plan §14.4 `aggregate`):
 * - any file still running → wait
 * - a CE anywhere stops judging
 * - otherwise the first non-AC file in order decides, after one rerun for a near-miss TLE or an IE
 * - all AC → next stage if there is one, else AC
 */
export function decide(s: StageState): Decision {
  if (s.files.some((f) => !f.outcome)) return { kind: 'wait' };
  const outcomes = s.files.map((f) => f.outcome!);
  const all = [...s.previous, ...outcomes];
  const stats = { maxCpuMs: maxOf(all.map((o) => o.cpuMs)), maxMemKb: maxOf(all.map((o) => o.memKb)) };

  const ce = outcomes.find((o) => o.verdict === 'CE');
  if (ce)
    return {
      kind: 'final',
      verdict: 'CE',
      failedOrdinal: null,
      failedCase: null,
      ...stats,
      message: ce.message,
    };

  const bad = outcomes.find((o) => o.verdict !== 'AC');
  if (bad) {
    if (bad.attempt === 1 && bad.verdict === 'TLE' && bad.nearMiss) {
      return { kind: 'rerun', ordinal: bad.ordinal, reason: 'near-miss' };
    }
    if (bad.attempt === 1 && bad.verdict === 'IE')
      return { kind: 'rerun', ordinal: bad.ordinal, reason: 'internal-error' };
    return {
      kind: 'final',
      verdict: bad.verdict,
      failedOrdinal: bad.ordinal,
      failedCase: bad.failedCase,
      ...stats,
      message: bad.message,
    };
  }
  if (s.hasNextStage) return { kind: 'next-stage' };
  return { kind: 'final', verdict: 'AC', failedOrdinal: null, failedCase: null, ...stats, message: null };
}
