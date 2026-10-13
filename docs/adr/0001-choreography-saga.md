# ADR 0001: Choreography saga with a transactional outbox

**Status:** accepted

## Context

Placing an order touches Order, Inventory and (from F6) Payment, and each owns its own
database. A distributed transaction (2PC) is slow, couples the services' availability, and
Kafka can't take part in one anyway.

## Decision

A **choreography saga**: each service reacts to the others' events and publishes its own;
nobody coordinates.

- Events are written with a **transactional outbox** in the same commit as the change, then
  sent to Kafka by a relay (at least once).
- Consumers are **idempotent**: the event id goes into `processed_events` in the same
  transaction as the handler's change.
- Each aggregate's **state machine** rejects impossible moves, so late or out-of-order
  events are ignored rather than applied.
- Failures go to a **retry topic** (1 s, 5 s, 15 s), then a **DLQ**; bad messages go straight
  to the DLQ.

## Consequences

- (+) No central coordinator; services stay independent; Kafka down ≠ checkout down (events
  wait in the outbox).
- (−) The flow is spread across services, so it is harder to follow. Mitigation: the
  correlation id travels in every event; tracing in F10.
- (−) Eventual consistency: an order is `PENDING` for a moment before it is `CONFIRMED`.
- (−) A retried event can run after a newer one for the same order; handlers must stay
  idempotent and state machines strict.
- Revisit with orchestration if the flow grows beyond about 4 steps, or needs timeouts and
  compensation that are hard to see when spread across services.
