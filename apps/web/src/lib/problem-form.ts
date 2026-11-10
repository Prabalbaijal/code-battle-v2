import type { AdminProblem, CreateProblemBody, UpdateProblemBody } from '@cb/contracts';
import { PROBLEM_LIMITS as L, type CheckerType, type Difficulty } from '@cb/contracts/constants';

/**
 * The problem statement form's values and their mapping to the API. Pure, so it is unit-tested:
 * an edit must PATCH only the fields that changed, because limit fields void calibration.
 */
export interface StatementValues {
  slug: string;
  title: string;
  difficulty: Difficulty;
  statementMd: string;
  inputFormatMd: string;
  outputFormatMd: string;
  /** One constraint per line. */
  constraints: string;
  examples: { input: string; output: string; explanation: string }[];
  /** Comma separated. */
  tags: string;
  memoryMb: number;
  outputLimitKb: number;
  checkerType: CheckerType;
  floatEps: string;
}

export const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
export const tagList = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

export function toValues(p?: AdminProblem): StatementValues {
  return {
    slug: p?.slug ?? '',
    title: p?.title ?? '',
    difficulty: p?.difficulty ?? 'Easy',
    statementMd: p?.statementMd ?? '',
    inputFormatMd: p?.inputFormatMd ?? '',
    outputFormatMd: p?.outputFormatMd ?? '',
    constraints: p?.constraints.join('\n') ?? '',
    examples: p?.examples.map((e) => ({ ...e, explanation: e.explanation ?? '' })) ?? [
      { input: '', output: '', explanation: '' },
    ],
    tags: p?.tags.join(', ') ?? '',
    memoryMb: (p?.memoryLimitKb ?? L.memoryKb.default) / 1024,
    outputLimitKb: p?.outputLimitKb ?? L.outputKb.default,
    checkerType: p?.checkerType ?? 'tokens',
    floatEps: p?.floatEps?.toString() ?? '',
  };
}

export function toCreateBody(v: StatementValues): CreateProblemBody {
  return {
    slug: v.slug,
    ...toUpdateBody(v),
  } as CreateProblemBody;
}

/** All statement fields as the API expects them; `only` limits it to the fields the user changed. */
export function toUpdateBody(v: StatementValues, only?: Set<keyof StatementValues>): UpdateProblemBody {
  const all: Record<keyof Omit<StatementValues, 'slug'>, () => Partial<UpdateProblemBody>> = {
    title: () => ({ title: v.title.trim() }),
    difficulty: () => ({ difficulty: v.difficulty }),
    statementMd: () => ({ statementMd: v.statementMd }),
    inputFormatMd: () => ({ inputFormatMd: v.inputFormatMd }),
    outputFormatMd: () => ({ outputFormatMd: v.outputFormatMd }),
    constraints: () => ({ constraints: lines(v.constraints) }),
    examples: () => ({
      examples: v.examples.map((e) => ({
        input: e.input,
        output: e.output,
        ...(e.explanation.trim() ? { explanation: e.explanation } : {}),
      })),
    }),
    tags: () => ({ tags: tagList(v.tags) }),
    memoryMb: () => ({ memoryLimitKb: Math.round(Number(v.memoryMb) * 1024) }),
    outputLimitKb: () => ({ outputLimitKb: Number(v.outputLimitKb) }),
    checkerType: () => ({ checkerType: v.checkerType, floatEps: v.floatEps ? Number(v.floatEps) : null }),
    floatEps: () => ({ floatEps: v.floatEps ? Number(v.floatEps) : null }),
  };
  return Object.assign(
    {},
    ...Object.entries(all)
      .filter(([k]) => !only || only.has(k as keyof StatementValues))
      .map(([, f]) => f()),
  ) as UpdateProblemBody;
}
