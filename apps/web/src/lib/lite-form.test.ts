import { describe, expect, it } from 'vitest';
import { rules } from './form';
import { check } from './lite-form';

describe('lite-form rules (same rule objects as react-hook-form)', () => {
  it('required, pattern, length and validate, in that order', () => {
    expect(check(rules.username, '', {})).toBe('Username is required');
    expect(check(rules.username, 'a!', {})).toBe('Use 3–20 letters, digits or _');
    expect(check(rules.username, 'admin', {})).toBe('This username is reserved');
    expect(check(rules.username, 'cara_1', {})).toBeUndefined();
    expect(check(rules.password, 'short', {})).toMatch(/at least/);
    expect(check(rules.email, 'nope', {})).toBe('Enter a valid email');
  });

  it('cross-field validation sees all values', () => {
    expect(check(rules.confirm, 'x', { password: 'y' })).toBe('Passwords do not match');
    expect(check(rules.confirm, 'same', { password: 'same' })).toBeUndefined();
  });

  it('an empty optional field is valid', () => {
    expect(check({ pattern: { value: /^\d+$/, message: 'digits' } }, '', {})).toBeUndefined();
  });
});
