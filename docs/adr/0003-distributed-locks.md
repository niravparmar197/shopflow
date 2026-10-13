# ADR 0003: Redis lock for efficiency, database for correctness

**Status:** accepted

## Context

Every service runs 2 or more pods, and a plain cron runs on every pod: the order expiry
job would cancel the same orders 3 times, and inventory would release the same stock 3
times. A scheduled job also has to survive a pod crashing mid-run, a run that takes longer
than its interval, and a slow pod that finishes after its lock has passed to another.

## Decision

- **One Redis lock per job** (`libs/scheduler`, `LeaderJob`): `SET key token NX PX ttl`,
  with Lua compare-and-renew and compare-and-release on an owner token. A heartbeat renews
  it at TTL/3; when renewal fails, the job is told (`ctx.lost`) and stops after its current
  batch. After a run the lock is kept until shortly before the next tick, so a pod whose
  timer fires a few milliseconds late doesn't run the same tick again.
- **Every data change inside a job is also fenced by the database**: small batches,
  `FOR UPDATE SKIP LOCKED`, and conditional updates through the state machines. The job
  stays correct even if two pods run it at once.
- One Redis node, not Redlock.

## Why not trust the lock alone (or Redlock)?

No lock service can stop a paused process: after a long GC pause or a network split, a pod
can still believe it holds a lock that expired and was given to another pod, and write.
Redlock adds Redis nodes but not that guarantee, and it depends on clocks. Fencing in the
database, where the data lives, makes a double run harmless, so the lock only has to save
work, and one Redis node is enough for that.

## Consequences

- (+) Proven by a test that runs the expiry job from 3 app copies **without** the lock and
  still cancels each order exactly once.
- (+) A crashed pod blocks a job for at most one TTL; no manual cleanup.
- (−) Jobs must be written as small, idempotent, row-locked batches, and check `ctx.lost`
  between batches.
- (−) Redis down = scheduled jobs skip their runs (logged) until it's back. Acceptable: the
  jobs are backstops, and the next run catches up.
- (−) The timers of different services must nest (payment 15 min < order 30 min; order 40
  min < hold 60 min). Changing one means checking the others (README, "Timing contract").
