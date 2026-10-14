# ShopFlow runbook

What to do when an alert fires. The alerts are defined in `infra/prometheus/alerts.yml`.

| Tool         | URL                                                      |
| ------------ | -------------------------------------------------------- |
| Grafana      | http://localhost:3010 (admin/admin, "ShopFlow Overview") |
| Prometheus   | http://localhost:9091 (`/alerts`)                        |
| Jaeger       | http://localhost:16686                                   |
| Alertmanager | http://localhost:9093                                    |
| Kafka UI     | http://localhost:8081                                    |
| Bull Board   | http://localhost:3006/queues                             |
| Mailpit      | http://localhost:8025 (alert emails)                     |

| Alert                   | First look                                                                                       | Usual fix                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| ServiceDown             | Is the process running? That service's logs                                                      | Restart it; check that PostgreSQL / Redis / Kafka are reachable              |
| HighErrorRate           | Grafana "5xx by service" → Jaeger: search `error=true` for that service                          | Roll back the last deploy; check a dependency (DB, payment provider)         |
| HighLatencyP95          | Jaeger: the slowest traces → which span is long (SQL? gRPC? provider?)                           | Index, cache, scale out, circuit breaker settings                            |
| DeadLetterQueueNotEmpty | Kafka UI → topic `<group>.dlq` → message header `x-error`                                        | Fix the cause, then `npm run dlq:replay -- <group>`                          |
| ConsumerLagHigh         | Which group? Is it running? Errors in its logs?                                                  | Scale consumers (at most one per partition), fix the slow handler            |
| OutboxStuck             | Is Kafka up? Relay errors in the service's logs?                                                 | Bring Kafka back; the relay drains the outbox by itself                      |
| PaymentCircuitOpen      | The provider's status page; `GET /v1/payments/dev/circuits`                                      | Wait (half-open test call after 30 s); raise it with the provider            |
| PaidWithoutReservation  | Inventory logs `ALERT: order … is PAID but has no RESERVED reservation` → Jaeger tag search by id | Check the stock by hand; refund or ship; review the payment-timeout contract |
| EventLoopBlocked        | CPU profile; recent code with synchronous work or large JSON                                     | Move heavy work to a worker or a queue                                       |

**Find one order end to end:** Jaeger → Search → Tags `shopflow.order_id=<id>`. Every trace of
that order shows up (checkout, payment webhook, timeout job). An error response's `traceId`
opens the exact request; log lines carry the same id as `trace_id`.
