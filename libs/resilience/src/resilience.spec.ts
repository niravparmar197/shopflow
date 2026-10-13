import { Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { CircuitOpenError, isRetryable } from './errors';
import { ResilienceRegistry } from './resilience.registry';
import {
  type ResilienceOptions,
  ResilientExecutor,
} from './resilient-executor';

// Small numbers so the suite runs in well under a second.
const FAST: ResilienceOptions = {
  timeoutMs: 50,
  retries: 2,
  minDelayMs: 1,
  maxDelayMs: 5,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 100,
  volumeThreshold: 3,
};

const httpError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

describe('isRetryable', () => {
  it.each([
    [httpError(500), true],
    [httpError(503), true],
    [httpError(429), true],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), true],
    [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), true],
    [httpError(400), false],
    [httpError(404), false],
    [new TypeError('x is undefined'), false],
    [new CircuitOpenError('dep'), false],
  ])('%s → %s', (err, expected) => {
    expect(isRetryable(err)).toBe(expected);
  });
});

describe('ResilientExecutor', () => {
  let ex: ResilientExecutor;
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  beforeAll(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  beforeEach(() => (ex = new ResilientExecutor('test', FAST)));
  afterEach(() => ex.shutdown());

  it('retries a temporary failure, then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValue('ok');
    await expect(ex.execute(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx', async () => {
    const fn = jest.fn().mockRejectedValue(httpError(400));
    await expect(ex.execute(fn)).rejects.toMatchObject({ statusCode: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('times out each slow attempt, gives up after the retries', async () => {
    const fn = jest.fn(() => sleep(500, 'late', { ref: false }));
    const started = Date.now();
    await expect(ex.execute(fn)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(400); // not 3 × 500 ms
  });

  it('opens the circuit, fails fast, then recovers via HALF_OPEN', async () => {
    const fn = jest.fn().mockRejectedValue(httpError(503));
    await expect(ex.execute(fn)).rejects.toBeDefined(); // 3 failed calls
    expect(ex.state).toBe('OPEN');

    // Open: rejected without calling fn, and without retrying.
    fn.mockClear();
    await expect(ex.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();

    // After resetTimeout one test call goes through; success closes it.
    await sleep(FAST.resetTimeoutMs + 20);
    expect(ex.state).toBe('HALF_OPEN');
    fn.mockResolvedValue('ok');
    await expect(ex.execute(fn)).resolves.toBe('ok');
    expect(ex.state).toBe('CLOSED');
  });

  it('4xx errors do not open the circuit', async () => {
    const fn = jest.fn().mockRejectedValue(httpError(422));
    for (let i = 0; i < 5; i++) await ex.execute(fn).catch(() => undefined);
    expect(ex.state).toBe('CLOSED');
  });
});

describe('ResilienceRegistry', () => {
  it('gives one shared executor per dependency', () => {
    const reg = new ResilienceRegistry();
    expect(reg.for('a')).toBe(reg.for('a'));
    expect(reg.for('a')).not.toBe(reg.for('b'));
    expect(reg.states()).toEqual({ a: 'CLOSED', b: 'CLOSED' });
    reg.onApplicationShutdown();
  });
});
