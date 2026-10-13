export class BulkheadFullError extends Error {
  constructor(readonly bulkhead: string) {
    super(`Bulkhead "${bulkhead}" is full`);
    this.name = 'BulkheadFullError';
  }
}

/**
 * BULKHEAD (like the walls in a ship): caps how many calls to ONE dependency
 * run at once. If it gets slow or flooded, only these seats fill up; the
 * rest of the service keeps working.
 *
 *   circuit breaker: "is it BROKEN?"           → stop calling it
 *   bulkhead:        "are we sending TOO MUCH?" → cap the concurrency
 *
 * The waiting queue is bounded too (an unbounded one just moves the problem
 * into memory). Full → BulkheadFullError at once: LOAD SHEDDING, say no fast.
 *
 * Counters are updated synchronously, so the "full?" check is exact even
 * when many calls arrive in the same tick. (p-limit v3 updates its counts
 * a microtask later, which makes a bounded-queue check on top of it racy.)
 */
export class Bulkhead {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) {
        throw new BulkheadFullError(this.name);
      }
      // Wait for a seat; release() hands it over directly (active stays).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats() {
    return { active: this.active, waiting: this.waiting.length };
  }

  private release() {
    const next = this.waiting.shift();
    if (next) {
      next(); // the seat passes straight to the next in line
    } else {
      this.active--;
    }
  }
}
