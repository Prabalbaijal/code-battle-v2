import type {
  AdminProblem,
  CalibrationReport,
  LanguageKey,
  PublicProblem,
  PublishBlocker,
} from '@cb/contracts';
import type { LimitRow, ProblemRow, ReferenceSolutionRow, TestFileRow } from '../../db/schema.js';

/** Largest CPU limit per language across files (what the statement shows). */
export function timeLimits(limits: LimitRow[]): Partial<Record<LanguageKey, number>> {
  const out: Partial<Record<LanguageKey, number>> = {};
  for (const l of limits) {
    const k = l.languageKey as LanguageKey;
    out[k] = Math.max(out[k] ?? 0, l.cpuLimitMs);
  }
  return out;
}

export const toPublic = (p: ProblemRow, limits: LimitRow[]): PublicProblem => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  statementMd: p.statementMd,
  inputFormatMd: p.inputFormatMd,
  outputFormatMd: p.outputFormatMd,
  constraints: p.constraints,
  examples: p.examples,
  difficulty: p.difficulty,
  tags: p.tags,
  memoryLimitKb: p.memoryLimitKb,
  timeLimitsMs: timeLimits(limits),
  version: p.version,
});

export const toAdmin = (
  p: ProblemRow,
  files: TestFileRow[],
  refs: ReferenceSolutionRow[],
  limits: LimitRow[],
  calibration: CalibrationReport | null,
  publishBlockers: PublishBlocker[],
): AdminProblem => ({
  ...toPublic(p, limits),
  status: p.status,
  checkerType: p.checkerType,
  floatEps: p.floatEps,
  outputLimitKb: p.outputLimitKb,
  calibratedAt: p.calibratedAt?.toISOString() ?? null,
  createdBy: p.createdBy,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  testFiles: files.map((f) => ({
    ordinal: f.ordinal,
    kind: f.kind,
    caseCount: f.caseCount,
    inputBytes: f.inputBytes,
    outputCaseLineCounts: f.outputCaseLineCounts,
    sha256: f.sha256,
  })),
  referenceSolutions: refs.map((r) => ({
    id: r.id,
    languageKey: r.languageKey as LanguageKey,
    expectedVerdict: r.expectedVerdict,
    createdAt: r.createdAt.toISOString(),
  })),
  limits: limits.map((l) => ({
    ordinal: l.ordinal,
    languageKey: l.languageKey as LanguageKey,
    cpuLimitMs: l.cpuLimitMs,
  })),
  calibration,
  publishBlockers,
});
