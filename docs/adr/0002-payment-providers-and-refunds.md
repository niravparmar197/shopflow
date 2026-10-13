# ADR 0002: Payment provider abstraction, webhooks as the source of truth, auto-refund

**Status:** accepted

## Context

ShopFlow takes payments through an external provider (Razorpay now; Stripe possible). The
provider is a network dependency we don't control: it can be slow, down or flaky. The
user's browser is also untrusted: it can close the tab, lose the network, or fake a
"success" redirect. Payment and Order own separate databases, so a payment that succeeds
at the wrong moment (after the order gave up) can't be undone with a rollback.

## Decision

- **One `PaymentProvider` interface** (Strategy) with an adapter per provider (Adapter) and
  a factory that picks one by config. The rest of the service never sees a provider SDK.
- **Only signed webhooks decide success**, never the frontend redirect. Each webhook is
  checked with an HMAC over the raw body and deduplicated by the provider's event id in
  the same transaction as the state change.
- **A failed attempt keeps the payment open** (the user can try another card); only the
  expiry (a sweeper job) is final.
- **Webhook and sweeper both lock the payment row** (`FOR UPDATE`; the sweeper uses
  `SKIP LOCKED`), then decide on the status they read under the lock. Exactly one final
  state.
- **A late success is refunded automatically**: success after the expiry, or after the
  order was cancelled, moves the payment to `REFUND_PENDING`; a lease-based job refunds it
  with the payment id as the idempotency key.
- **Every provider call** goes through retry (temporary errors only) + circuit breaker +
  timeout, with the retry budget below the gateway's timeout.

## Consequences

- (+) The frontend can lie or vanish without effect; providers retry webhooks for hours to
  days, so success is not lost while we are down.
- (+) Money is never stuck: no manual support work for "paid but cancelled".
- (+) A provider outage fails fast instead of piling up requests and taking ShopFlow down.
- (+) Adding a provider is one adapter plus one factory case.
- (−) More states (`REFUND_PENDING`, `REFUNDED`) and a sweeper job to run and monitor
  (alerts on stuck `REFUND_PENDING` rows come with F10).
- (−) A customer can be charged and refunded for an order that was cancelled a moment
  earlier. Rare, visible on their statement, and better than keeping the money.
- (−) Razorpay orders have no idempotency key: a double-clicked checkout can create two
  provider orders. We store and show only one; the other is never paid and expires.
