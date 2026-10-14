import { Logger } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { getOrCreate, registry } from '@app/observability';
import CircuitBreaker from 'opossum';
import pRetry, { AbortError } from 'p-retry';
import { CircuitOpenError, isRetryable } from './errors';

export interface ResilienceOptions {
  timeoutMs: number; // per attempt
  retries: number; // extra attempts after the first
  minDelayMs: number; // first backoff
  maxDelayMs: number; // backoff cap
  errorThresholdPercentage: number;
  resetTimeoutMs: number; // how long the circuit stays OPEN
  volumeThreshold: number; // min calls before the breaker may open
}

/**
 * Worst case: 3 attempts × 2 s + backoff ≈ 6.6 s. Keep this below the
 * gateway's proxy timeout for the route, or the user gets a 504 while we
 * are still retrying.
 */
export const DEFAULT_RESILIENCE: ResilienceOptions = {
  timeoutMs: 2_000,
  retries: 2,
  minDelayMs: 200,
  maxDelayMs: 2_000,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 30_000,
  volumeThreshold: 5,
};

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const circuitState = getOrCreate(
  'circuit_state',
  () =>
    new Gauge({
      name: 'circuit_state',
      help: '0 closed, 1 half-open, 2 open',
      labelNames: ['dependency'],
      registers: [registry],
    }),
);

/*
 * retry (backoff + jitter, temporary errors only)
 *   └─ circuit breaker (too many failures → fail fast for resetTimeout)
 *        └─ timeout (per attempt)
 *             └─ fn()
 *
 * CLOSED ──(≥ threshold % failed, min volume)──► OPEN ──(resetTimeout)──► HALF_OPEN
 *   ▲                                                                       │ 1 test call
 *   └──────────────── test call OK ◄──────── test call fails → OPEN again ──┘
 */
export class ResilientExecutor {
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor(
    private readonly name: string,
    private readonly opts: ResilienceOptions,
  ) {
    this.logger = new Logger(`Resilience:${name}`);

    // One breaker per DEPENDENCY. It runs whatever function it is given.
    this.breaker = new CircuitBreaker((fn: () => Promise<unknown>) => fn(), {
      name,
      timeout: opts.timeoutMs,
      errorThresholdPercentage: opts.errorThresholdPercentage,
      resetTimeout: opts.resetTimeoutMs,
      volumeThreshold: opts.volumeThreshold,
      rollingCountTimeout: 10_000,
      // A 4xx means OUR request was bad, not that the dependency is sick:
      // don't count it as a failure.
      errorFilter: (err) => !isRetryable(err),
    });

    circuitState.set({ dependency: name }, 0);
    this.breaker.on('open', () => circuitState.set({ dependency: name }, 2));
    this.breaker.on('halfOpen', () =>
      circuitState.set({ dependency: name }, 1),
    );
    this.breaker.on('close', () => circuitState.set({ dependency: name }, 0));
    this.breaker.on('open', () =>
      this.logger.error(
        `Circuit OPEN: failing fast for ${opts.resetTimeoutMs / 1000}s`,
      ),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn('Circuit HALF_OPEN: sending one test call'),
    );
    this.breaker.on('close', () =>
      this.logger.log('Circuit CLOSED: dependency is healthy again'),
    );
    this.breaker.on('timeout', () =>
      this.logger.warn(`Call timed out after ${opts.timeoutMs} ms`),
    );
  }

  get state(): CircuitState {
    if (this.breaker.opened) return 'OPEN';
    if (this.breaker.halfOpen) return 'HALF_OPEN';
    return 'CLOSED';
  }

  execute<T>(fn: () => Promise<T>): Promise<T> {
    return pRetry(
      async () => {
        try {
          return (await this.breaker.fire(fn)) as T;
        } catch (err) {
          // The circuit is open: retrying now is pointless. Stop at once.
          if ((err as { code?: string }).code === 'EOPENBREAKER') {
            throw new AbortError(new CircuitOpenError(this.name));
          }
          // 4xx / bug: a retry gets the same result. Stop at once.
          if (!isRetryable(err)) throw new AbortError(err as Error);
          throw err; // temporary: p-retry waits, then tries again
        }
      },
      {
        retries: this.opts.retries,
        factor: 2, // 200 ms → 400 ms → 800 ms…
        minTimeout: this.opts.minDelayMs,
        maxTimeout: this.opts.maxDelayMs,
        randomize: true, // JITTER: clients don't all retry at the same moment
        onFailedAttempt: (e) =>
          this.logger.warn(
            `Attempt ${e.attemptNumber} failed (${e.retriesLeft} left): ${e.message}`,
          ),
      },
    );
  }

  /** Stops the breaker's timers (tests, shutdown). */
  shutdown() {
    this.breaker.shutdown();
  }
}
