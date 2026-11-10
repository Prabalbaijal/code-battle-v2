import { LANGUAGE_KEYS } from '@cb/contracts';
import { describe, expect, it } from 'vitest';
import { publishBlockers, type PublishInput } from './publish-rules.js';

const files = [
  { ordinal: 1, kind: 'sample' as const },
  { ordinal: 2, kind: 'small' as const },
  { ordinal: 3, kind: 'large' as const },
];
const ready: PublishInput = {
  status: 'draft',
  exampleCount: 1,
  files,
  references: [
    { languageKey: 'cpp', expectedVerdict: 'AC' },
    { languageKey: 'python', expectedVerdict: 'TLE' },
  ],
  limits: files.flatMap((f) => LANGUAGE_KEYS.map((languageKey) => ({ ordinal: f.ordinal, languageKey }))),
  calibratedAt: new Date(),
};
const codes = (p: Partial<PublishInput>) => publishBlockers({ ...ready, ...p }).map((b) => b.code);

describe('publishBlockers', () => {
  it('a complete, calibrated problem has none', () => {
    expect(publishBlockers(ready)).toEqual([]);
  });

  it('lists every missing piece at once', () => {
    expect(codes({ exampleCount: 0, files: [], references: [], limits: [], calibratedAt: null })).toEqual([
      'NO_EXAMPLES',
      'NO_SAMPLE_FILE',
      'NO_SMALL_FILE',
      'NO_LARGE_FILE',
      'NO_CPP_AC_REFERENCE',
      'NO_TLE_REFERENCE',
      'NOT_CALIBRATED',
    ]);
  });

  it('needs a C++ AC reference specifically, and a TLE one', () => {
    expect(codes({ references: [{ languageKey: 'python', expectedVerdict: 'AC' }] })).toEqual([
      'NO_CPP_AC_REFERENCE',
      'NO_TLE_REFERENCE',
    ]);
  });

  it('reports missing calibrated limits per file and language', () => {
    const blockers = publishBlockers({
      ...ready,
      limits: ready.limits.filter((l) => !(l.ordinal === 3 && l.languageKey === 'java')),
    });
    expect(blockers).toEqual([
      { code: 'MISSING_LIMITS', message: 'Calibration has no time limit for java on file 3' },
    ]);
  });

  it('archived problems cannot be published', () => {
    expect(codes({ status: 'archived' })).toEqual(['ARCHIVED']);
  });
});
