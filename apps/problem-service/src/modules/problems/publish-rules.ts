import { LANGUAGE_KEYS } from '@cb/contracts';

export interface PublishInput {
  status: 'draft' | 'published' | 'archived';
  exampleCount: number;
  files: { ordinal: number; kind: 'sample' | 'small' | 'large' }[];
  references: { languageKey: string; expectedVerdict: 'AC' | 'TLE' | 'WA' }[];
  limits: { ordinal: number; languageKey: string }[];
  calibratedAt: Date | null;
}

export interface Blocker {
  code: string;
  message: string;
}

/**
 * Everything that stops a problem from being published (plan §14.2, §14.7), all at once so the
 * admin UI can show a checklist. Empty array = publishable.
 */
export function publishBlockers(p: PublishInput): Blocker[] {
  const out: Blocker[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  const kinds = new Set(p.files.map((f) => f.kind));

  if (p.status === 'archived') add('ARCHIVED', 'Archived problems cannot be published');
  if (p.exampleCount < 1) add('NO_EXAMPLES', 'Add at least one example to the statement');
  if (!kinds.has('sample')) add('NO_SAMPLE_FILE', 'Upload a sample test file (the statement examples)');
  if (!kinds.has('small'))
    add('NO_SMALL_FILE', 'Upload a small test file with every correctness and edge case');
  if (!kinds.has('large')) add('NO_LARGE_FILE', 'Upload at least one large test file for performance');

  if (!p.references.some((r) => r.languageKey === 'cpp' && r.expectedVerdict === 'AC')) {
    add('NO_CPP_AC_REFERENCE', 'Add an accepted C++ reference solution');
  }
  if (!p.references.some((r) => r.expectedVerdict === 'TLE')) {
    add('NO_TLE_REFERENCE', 'Add a must-TLE solution (e.g. brute force) so limits can be checked');
  }

  if (!p.calibratedAt) {
    add('NOT_CALIBRATED', 'Run calibration after the last change to tests or limits');
  } else {
    const have = new Set(p.limits.map((l) => `${l.ordinal}:${l.languageKey}`));
    const missing = p.files.flatMap((f) =>
      LANGUAGE_KEYS.filter((lang) => !have.has(`${f.ordinal}:${lang}`)).map(
        (lang) => `${lang} on file ${f.ordinal}`,
      ),
    );
    if (missing.length) add('MISSING_LIMITS', `Calibration has no time limit for ${missing.join(', ')}`);
  }
  return out;
}
