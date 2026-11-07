import { describe, expect, it } from 'vitest';
import { isRetryableTxError, isUniqueViolation, pgErrorCode } from './errors.js';

describe('pg error helpers', () => {
  it('finds the pg error through drizzle-style cause chains', () => {
    const pgErr = Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_key' });
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgErr });
    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'users_email_key')).toBe(true);
    expect(isUniqueViolation(wrapped, 'other')).toBe(false);
  });

  it('classifies retryable transaction errors', () => {
    expect(isRetryableTxError({ code: '40001' })).toBe(true);
    expect(isRetryableTxError({ cause: { code: '40P01' } })).toBe(true);
    expect(isRetryableTxError({ code: 'ECONNRESET' })).toBe(false);
    expect(isRetryableTxError(new Error('x'))).toBe(false);
  });
});
