import { setTimeout as sleep } from 'node:timers/promises';
import { Bulkhead, BulkheadFullError } from './bulkhead';

/** A call that stays "in flight" until we let it finish. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  return { done, open };
}

describe('Bulkhead', () => {
  it('runs at most maxConcurrent at once; the rest wait their turn', async () => {
    const b = new Bulkhead('t', 2, 10);
    let active = 0;
    let peak = 0;
    const work = () =>
      b.run(async () => {
        peak = Math.max(peak, ++active);
        await sleep(20);
        active--;
        return 'ok';
      });

    const results = await Promise.all(Array.from({ length: 8 }, work));
    expect(results).toEqual(Array(8).fill('ok'));
    expect(peak).toBe(2);
    expect(b.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('sheds load at once when the seats AND the queue are full', async () => {
    const b = new Bulkhead('t', 1, 1);
    const g = gate();
    const first = b.run(() => g.done); // takes the seat
    const second = b.run(() => Promise.resolve('queued')); // waits
    await expect(b.run(() => Promise.resolve('x'))).rejects.toBeInstanceOf(
      BulkheadFullError,
    );
    expect(b.stats()).toEqual({ active: 1, waiting: 1 });

    g.open();
    await first;
    await expect(second).resolves.toBe('queued');
  });

  it('a queue of 0 still lets calls in while there are free seats', async () => {
    const b = new Bulkhead('t', 1, 0);
    const g = gate();
    const first = b.run(() => g.done); // the one seat
    // Same tick: no seat, no queue → shed.
    await expect(b.run(() => Promise.resolve())).rejects.toThrow(
      'Bulkhead "t" is full',
    );
    g.open();
    await first;
    await expect(b.run(() => Promise.resolve('free again'))).resolves.toBe(
      'free again',
    );
  });

  it('a failing call still frees its seat', async () => {
    const b = new Bulkhead('t', 1, 0);
    await expect(
      b.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(b.stats()).toEqual({ active: 0, waiting: 0 });
    await expect(b.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
