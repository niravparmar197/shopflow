# ADR 0004: OpenTelemetry + Prometheus, and a CQRS-lite read model

**Status:** accepted

## Context

One order touches six services, Kafka, an outbox and BullMQ. A log line per service can't
answer "where was this order slow?" or "is checkout healthy right now?". Separately, the
"My orders" screen needs data from two services (order status and payment status), and
joining them per request means a synchronous call to Payment on every page view.

## Decision

- **Tracing: OpenTelemetry** (vendor-neutral). Jaeger locally; any OTLP backend (Tempo,
  X-Ray, Datadog) later without code changes. The outbox breaks automatic propagation, so
  `traceparent` is stored in the event envelope and restored by the relay and the consumers
  (Kafka headers); BullMQ jobs carry it the same way. A test proves one trace spans two
  Kafka hops with the right parent/child links.
- **Metrics: Prometheus** (pull) + Grafana + Alertmanager, all configured as code in git.
  Labels are low-cardinality only: route templates, never raw URLs or ids. Ids belong in
  traces.
- **Read model:** one projection table per screen (`order_views`), built from order and
  payment events. Writes are idempotent (processed_events), order-independent (upserts;
  an early event makes a placeholder row) and monotonic (a status rank, not timestamps,
  because clocks on different producers disagree). The table can be rebuilt from the topics
  within their retention; a backfill from the write model covers older orders. This is not
  event sourcing: the orders tables stay the source of truth.

## Consequences

- Lists are eventually consistent. A read-your-writes fallback serves orders placed in the
  last 30 s from the write model (`syncing: true`) until the projection catches up.
- More to run: Prometheus, Grafana, Alertmanager, Jaeger, kafka-exporter.
- Every new alert needs a runbook entry (`docs/runbook.md`).
