import { describe, expect, it } from 'vitest';
import { InMemoryTokenBucket } from './index.js';

describe('InMemoryTokenBucket', () => {
  it('allows bursts up to capacity, then refills over time', () => {
    let now = 0;
    const b = new InMemoryTokenBucket({ capacity: 3, refillPerSec: 1 }, () => now);
    expect([1, 2, 3].map(() => b.consume('u').allowed)).toEqual([true, true, true]);
    const denied = b.consume('u');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
    now = 1000;
    expect(b.consume('u').allowed).toBe(true);
    expect(b.consume('other').allowed).toBe(true);
  });

  it('never exceeds capacity after long idle', () => {
    let now = 0;
    const b = new InMemoryTokenBucket({ capacity: 2, refillPerSec: 10 }, () => now);
    b.consume('k');
    now = 1_000_000;
    expect(b.consume('k').remaining).toBe(1);
  });
});
