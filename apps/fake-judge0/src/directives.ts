import { STATUS_ALIASES, type StatusId } from './judge0.js';

/**
 * Scripted behaviour, written as a comment anywhere in the source code:
 *   // @fake status=TLE time=2.3 memory=2048 delay=500
 *   # @fake program=sum-cases
 *   // @fake status=NZEC stderr="java.lang.OutOfMemoryError"
 * Keys: status (AC|WA|TLE|CE|SEGV|XFSZ|FPE|ABRT|NZEC|RE|OTHER|IE|EXEC), time, wall, memory (KB),
 * delay (ms until finished), stdout, stderr, compile_output, program (echo | sum-cases).
 * Quoted values support \n escapes.
 */
export interface Directives {
  status?: StatusId;
  time?: number;
  wall?: number;
  memory?: number;
  delay?: number;
  stdout?: string;
  stderr?: string;
  compileOutput?: string;
  program?: 'echo' | 'sum-cases';
}

const PAIR = /(\w+)=("((?:[^"\\]|\\.)*)"|\S+)/g;

const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');

export function parseDirectives(source: string): Directives {
  const d: Directives = {};
  for (const line of source.split('\n')) {
    const at = line.indexOf('@fake');
    if (at === -1) continue;
    for (const m of line.slice(at + 5).matchAll(PAIR)) {
      const key = m[1]!;
      const value = m[3] !== undefined ? unescape(m[3]) : m[2]!;
      switch (key) {
        case 'status': {
          const id = STATUS_ALIASES[value.toUpperCase()];
          if (!id) throw new Error(`unknown @fake status "${value}"`);
          d.status = id;
          break;
        }
        case 'time':
        case 'wall':
        case 'memory':
        case 'delay':
          d[key] = Number(value);
          break;
        case 'stdout':
        case 'stderr':
          d[key] = value;
          break;
        case 'compile_output':
          d.compileOutput = value;
          break;
        case 'program':
          if (value !== 'echo' && value !== 'sum-cases') throw new Error(`unknown @fake program "${value}"`);
          d.program = value;
          break;
        default:
          throw new Error(`unknown @fake key "${key}"`);
      }
    }
  }
  return d;
}

/** Tiny "programs" so judge pipelines can be tested end-to-end with real outputs. */
export function runProgram(program: Directives['program'], stdin: string): string {
  if (program === 'echo') return stdin;
  if (program === 'sum-cases') {
    // "t test cases" format: first line t, then t lines of integers → one sum per line.
    const lines = stdin.split(/\r?\n/).filter((l) => l.trim() !== '');
    const t = Number(lines[0]);
    return (
      lines
        .slice(1, 1 + t)
        .map((l) =>
          l
            .trim()
            .split(/\s+/)
            .reduce((acc, n) => acc + BigInt(n), 0n)
            .toString(),
        )
        .join('\n') + '\n'
    );
  }
  return '';
}
