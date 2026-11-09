import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { backoffDelay, retry } from './retry.js';
import { TimeoutError, withTimeout } from './timeout.js';

describe('retry', () => {
  it('retries until success and reports attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue(7);
    const onRetry = vi.fn();
    await expect(retry(fn, { retries: 3, sleep: async () => {}, onRetry })).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('stops when shouldRetry is false and when retries run out', async () => {
    const fatal = vi.fn().mockRejectedValue(new Error('4xx'));
    await expect(
      retry(fatal, { retries: 5, shouldRetry: () => false, sleep: async () => {} }),
    ).rejects.toThrow('4xx');
    expect(fatal).toHaveBeenCalledTimes(1);
    const always = vi.fn().mockRejectedValue(new Error('down'));
    await expect(retry(always, { retries: 2, sleep: async () => {} })).rejects.toThrow('down');
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('uses delayFor override (Retry-After) and bounded full-jitter backoff', async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue('ok');
    await retry(fn, { retries: 1, delayFor: () => 1234, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([1234]);
    expect(backoffDelay(10, 100, 5000, () => 0.999)).toBeLessThan(5000);
    expect(backoffDelay(0, 100, 5000, () => 0.5)).toBe(50);
  });
});

describe('CircuitBreaker', () => {
  it('opens after threshold, half-opens after timeout, closes on successful probe', async () => {
    let now = 0;
    const changes: string[] = [];
    const cb = new CircuitBreaker({
      name: 't',
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      now: () => now,
      onStateChange: (a, b) => changes.push(`${a}->${b}`),
    });
    const fail = () => cb.exec(() => Promise.reject(new Error('x')));
    await expect(fail()).rejects.toThrow('x');
    await expect(fail()).rejects.toThrow('x');
    expect(cb.currentState).toBe('open');
    await expect(cb.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    now = 1000;
    expect(cb.currentState).toBe('half_open');
    await expect(cb.exec(async () => 1)).resolves.toBe(1);
    expect(cb.currentState).toBe('closed');
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('re-opens when the half-open probe fails and ignores non-failures', async () => {
    let now = 0;
    const cb = new CircuitBreaker({
      name: 't',
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => now,
      isFailure: (e) => (e as Error).message !== 'client-error',
    });
    await expect(cb.exec(() => Promise.reject(new Error('client-error')))).rejects.toThrow();
    expect(cb.currentState).toBe('closed');
    await expect(cb.exec(() => Promise.reject(new Error('boom')))).rejects.toThrow();
    now = 10;
    await expect(cb.exec(() => Promise.reject(new Error('boom')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');
  });
});

describe('withTimeout', () => {
  it('rejects slow promises', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 50)), 5)).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(3), 50)).resolves.toBe(3);
  });
});
