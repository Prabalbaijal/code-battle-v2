export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(readonly breaker: string) {
    super(`circuit "${breaker}" is open`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long to stay open before letting a probe through. */
  resetTimeoutMs?: number;
  /** Decide which errors count as failures (e.g. ignore 4xx). Default: all. */
  isFailure?: (err: unknown) => boolean;
  now?: () => number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

/**
 * Minimal circuit breaker: closed → (N consecutive failures) → open → (after reset timeout)
 * half_open → one probe: success → closed, failure → open.
 * Used to stop hammering a dependency (Judge0, Redis, other services) that is down.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly resetMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.threshold = opts.failureThreshold ?? 5;
    this.resetMs = opts.resetTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get currentState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetMs) return 'half_open';
    return this.state;
  }

  /** True when a call would be rejected right now. */
  get isOpen(): boolean {
    const s = this.currentState;
    return s === 'open' || (s === 'half_open' && this.probeInFlight);
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'open') throw new CircuitOpenError(this.opts.name);
    if (state === 'half_open') {
      if (this.probeInFlight) throw new CircuitOpenError(this.opts.name);
      this.transition('half_open');
      this.probeInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.opts.isFailure?.(err) ?? true) this.onFailure();
      else this.onSuccess();
      throw err;
    } finally {
      this.probeInFlight = false;
    }
  }

  private onSuccess() {
    this.failures = 0;
    if (this.state !== 'closed') this.transition('closed');
  }

  private onFailure() {
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private transition(to: BreakerState) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.opts.onStateChange?.(from, to);
  }
}
