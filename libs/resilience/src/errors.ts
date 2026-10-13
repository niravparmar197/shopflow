export class CircuitOpenError extends Error {
  constructor(public readonly dependency: string) {
    super(`Circuit open for ${dependency}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Is this error worth retrying?
 *   YES: network errors, timeouts, 5xx, 429 (rate limited)
 *   NO:  4xx (our request is wrong: a retry gets the same answer), bugs
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  ) {
    return false; // a bug in our code
  }
  const e = err as { statusCode?: number; status?: number; code?: string };
  if (e?.code === 'ETIMEDOUT') return true;
  const status = e?.statusCode ?? e?.status;
  if (status === undefined) return true; // ECONNRESET, ENOTFOUND, socket hang up…
  return status === 429 || status >= 500;
}
