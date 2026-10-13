# ShopFlow

An e-commerce backend built as a set of [NestJS](https://nestjs.com/) microservices in a single monorepo.

> **Status:** F1 (auth) is done: signup, login, JWT access tokens and refresh token rotation in the `user` service, behind the `gateway`. The other services are still scaffolds.

## Services

| Service        | Path                | Default port | Responsibility (planned)                          |
| -------------- | ------------------- | ------------ | ------------------------------------------------- |
| `gateway`      | `apps/gateway`      | 3000         | Public HTTP entry point; routes to other services |
| `user`         | `apps/user`         | 3001         | Accounts, authentication, profiles                |
| `product`      | `apps/product`      | 3002         | Product catalog                                   |
| `inventory`    | `apps/inventory`    | 3005         | Stock levels and reservations                     |
| `order`        | `apps/order`        | 3003         | Order creation and lifecycle                      |
| `payment`      | `apps/payment`      | 3004         | Payment processing                                |
| `notification` | `apps/notification` | 3006         | Email / SMS / push notifications                  |

`gateway` is the default project, so Nest CLI commands without a project name target it.

## Shared libraries

Imported via TypeScript path aliases (see `tsconfig.json`).

| Library      | Alias             | Purpose (planned)                                            |
| ------------ | ----------------- | ------------------------------------------------------------ |
| `common`     | `@app/common`     | Shared utilities, DTOs, guards, filters                      |
| `events`     | `@app/events`     | Event names and payload contracts                            |
| `kafka`      | `@app/kafka`      | Kafka client/producer/consumer wiring                        |
| `proto`      | `@app/proto`      | gRPC protobuf definitions                                    |
| `resilience` | `@app/resilience` | Retry + circuit breaker + timeout for calls to other systems |
| `scheduler`  | `@app/scheduler`  | Redis lock + LeaderJob base for scheduled jobs on many pods  |

## Project structure

```
shopflow/
├── apps/
│   ├── gateway/
│   ├── inventory/
│   ├── notification/
│   ├── order/
│   ├── payment/
│   ├── product/
│   └── user/
├── libs/
│   ├── common/
│   ├── events/
│   ├── kafka/
│   └── proto/
├── nest-cli.json      # monorepo project definitions
└── package.json
```

## Getting started

### Prerequisites

- Node.js 22.12+
- npm
- Docker (local infrastructure and integration tests)

### Install

```bash
npm install
```

### Set up locally

```bash
docker compose -f infra/docker-compose.yml up -d   # Postgres (5434), Redis (6380), MinIO (9002, console 9003), ...
cp apps/user/.env.example apps/user/.env           # then set USER/PASSWORD in DATABASE_URL (shop/shop locally)
cp apps/gateway/.env.example apps/gateway/.env
node scripts/generate-jwt-keys.js                  # writes keys/ (git-ignored)
npm run migration:run:user
```

### Run a service

Pass the project name to the Nest CLI:

```bash
npx nest start gateway --watch
```

Each service listens on its default port from the table above, so several can run side by side. Override it with the `PORT` environment variable:

```bash
# bash
PORT=4001 npx nest start user --watch
```

```powershell
# PowerShell
$env:PORT=4001; npx nest start user --watch
```

### Build

```bash
npx nest build gateway        # outputs to dist/apps/gateway
node dist/apps/gateway/main
```

## Auth (F1)

```
Client → Gateway (:3000) → User service (:3001) → PostgreSQL users_db
```

- Signup / login in the User service; passwords hashed with bcrypt (12 rounds)
- Access token: JWT RS256, 15 min, sent as `Authorization: Bearer`. Only the User service holds the private key; the gateway verifies with the public key
- Refresh token: random, 7 days, in an httpOnly + `SameSite=Strict` cookie scoped to `/v1/auth`, stored only as a SHA-256 hash
- Refresh rotation with reuse detection: reusing a spent token revokes its whole family. A row lock serializes concurrent refreshes
- Gateway: JWT check, correlation id (`x-correlation-id`, logged by every service), Redis rate limits (100/min global, 5/min login), 5 s timeouts, strips client-sent `x-user-*` headers
- Errors everywhere use one shape: `{ code, message, details?, correlationId }`

| Endpoint                | Auth         | Notes                                   |
| ----------------------- | ------------ | --------------------------------------- |
| `POST /v1/auth/signup`  | none         | `{ email, password, name }`             |
| `POST /v1/auth/login`   | none         | returns `accessToken`, sets `rt` cookie |
| `POST /v1/auth/refresh` | `rt` cookie  | rotates the cookie, new `accessToken`   |
| `POST /v1/auth/logout`  | `rt` cookie  | revokes the token family                |
| `GET /v1/users/me`      | Bearer token | current user                            |

## Products (F2)

```
Client → Gateway ──gRPC──▶ Product service ──▶ Redis (cache) ──▶ MongoDB
Admin  → presigned POST ──▶ S3 / MinIO  (server never handles the file)
```

- Product service: MongoDB catalog (flexible attributes), compound + text indexes
- Cursor pagination (stable, fast at any depth), max 50 per page
- Gateway → Product over **gRPC** (proto contract in `libs/proto`), 2 s deadline, error mapping
- Redis cache-aside: single-flight, TTL jitter, negative cache, versioned list keys, fail-open
- Optimistic locking with `version` (409 on stale update)
- Images: S3 presigned POST (5 MB, type locked) → `tmp/` → confirm → `products/`; `tmp/` auto-deleted after 1 day
- Tests: unit (cache, images with S3 mocked) + integration with real MongoDB + Redis via Testcontainers (`npm run test:e2e:product`), covering pagination, roles, 409s, cache invalidation, concurrent edits and the gRPC contract

## Cart + coupons (F3)

```
Client → Gateway (JWT) → Order service ──▶ Redis: cart:{userId} (7-day TTL)
                              ├──gRPC──▶ Product: live prices (1 s deadline)
                              └────────▶ PostgreSQL: coupons
```

- Cart in a Redis hash `cart:{userId}` (productId → qty). Prices are never stored; they always come live from the product service
- Limits (20 different items, qty ≤ 10) enforced atomically with Redis Lua scripts, so parallel adds can't overshoot
- Product service down → the cart still loads without prices (`pricingAvailable: false`); adding returns 503
- Coupons in PostgreSQL. Rules are a **Chain of Responsibility** (Active → Dates → Usage → MinCart → Category → FirstOrder); discounts are a **Strategy** (Percent with cap / Flat)
- The coupon is re-checked on every cart read; if the cart stops qualifying it shows `applied: false` + reason instead of failing
- Tests: integration with real PostgreSQL + Redis via Testcontainers, product service faked (`npm run test:e2e:order`), incl. 25 parallel adds → exactly 20 items

| Endpoint                              | Auth  | Notes                                        |
| ------------------------------------- | ----- | -------------------------------------------- |
| `GET /v1/cart`                        | user  | items, live prices, coupon, totals           |
| `POST /v1/cart/items`                 | user  | `{ productId, qty }`, adds to existing qty   |
| `PATCH /v1/cart/items/:productId`     | user  | `{ qty }`                                    |
| `DELETE /v1/cart/items/:productId`    | user  |                                              |
| `POST /v1/cart/coupon`                | user  | `{ code }`, 400 with the reason if not valid |
| `DELETE /v1/cart/coupon`              | user  |                                              |
| `POST /v1/coupons`, `GET /v1/coupons` | admin | create / list coupons                        |

## Orders (F4)

```
POST /v1/orders ─▶ Redis checkout lock (per user)
                   ├─ cart (Redis) + live prices (gRPC)       outside the transaction
                   ├─ BEGIN
                   │    advisory lock (per user) → coupon rules → used_count + 1 (atomic)
                   │    order + item snapshots → outbox "order.created" → idempotency result
                   │  COMMIT
                   └─ clear the cart
```

- **State pattern** for order status (`PENDING → CONFIRMED → PAID → SHIPPED → DELIVERED`, plus `CANCELLED` / `FAILED`); any other move is `409 INVALID_ORDER_TRANSITION`
- **Idempotency-Key** on `POST /v1/orders`: same key + same body replays the saved response (`Idempotent-Replayed: true`); the result is saved in the same transaction as the order, so a crashed request can be taken over safely after 2 min
- **Transactional outbox**: `order.created` is written in the same commit as the order, ready for the Kafka publisher (F5)
- Coupon use is one conditional `UPDATE` (no read-then-write race); failures roll back everything, including the coupon use
- Items keep a snapshot of name and price; later product changes don't alter past orders
- Tests (`npm run test:e2e:order`): replay, 5 parallel requests with one key, last coupon use raced by 2 users, same user with 2 keys, rollback, product service down, IDOR, cursor pagination

| Endpoint                      | Auth | Notes                                                                                   |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `POST /v1/orders`             | user | `Idempotency-Key` header (8–100 chars); body `{ expectedTotalPaise? }`; 10/min per user |
| `GET /v1/orders?limit&cursor` | user | newest first, cursor pagination (max 50)                                                |
| `GET /v1/orders/:id`          | user | only your own orders, otherwise 404                                                     |

| Error code                                             | HTTP | Meaning                                                                    |
| ------------------------------------------------------ | ---- | -------------------------------------------------------------------------- |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | 400  | header missing or badly formed                                             |
| `CART_EMPTY`                                           | 422  | nothing to order                                                           |
| `CART_ITEM_UNAVAILABLE`                                | 409  | a product was removed or deactivated; `details.productIds`                 |
| `PRICE_CHANGED`                                        | 409  | `expectedTotalPaise` is out of date; `details.totalPaise` is the new total |
| `COUPON_NOT_APPLICABLE` / `COUPON_EXHAUSTED`           | 409  | coupon failed a rule / its last use was just taken                         |
| `IDEMPOTENCY_KEY_REUSED`                               | 422  | same key, different body                                                   |
| `IDEMPOTENCY_IN_PROGRESS` / `CHECKOUT_IN_PROGRESS`     | 409  | the first request (or another checkout) is still running; retry soon       |
| `SERVICE_UNAVAILABLE`                                  | 503  | product service down; nothing was saved                                    |
| `TOO_MANY_REQUESTS`                                    | 429  | more than 10 order requests a minute                                       |

## Events (F5)

```
order.created ─▶ Inventory ─┬─▶ stock.reserved ─▶ Order: PENDING → CONFIRMED (+ order.confirmed)
                            └─▶ stock.failed   ─▶ Order: PENDING → FAILED    (+ order.failed)
```

| Topic                           | Key          | Events                                                                              |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `order-events`                  | orderId      | `order.created`, `order.confirmed`, `order.failed`, `order.paid`, `order.cancelled` |
| `inventory-events`              | orderId      | `stock.reserved`, `stock.failed`                                                    |
| `payment-events`                | orderId      | `payment.succeeded`, `payment.failed`, `payment.refunded`                           |
| `<group>.retry` / `<group>.dlq` | original key | failed messages (headers `x-error`, `x-attempt`, `x-original-topic`)                |

- **Outbox relay** (`libs/kafka`): at-least-once delivery from the outbox table to Kafka, keyed by aggregate id so one order's events stay in order
- **BaseConsumer** (template method): every consumer records the `eventId` in `processed_events` in the **same transaction** as its change, so duplicates have no effect (exactly-once effect)
- **Reserve stock**: one conditional `UPDATE … WHERE available >= qty` per product (no oversell), rows locked in sorted order (no deadlock), savepoint for all-or-nothing
- **Failures**: poison (bad JSON / schema / version) → `<group>.dlq` at once; other errors → `<group>.retry` after 1 s, 5 s, 15 s, then the DLQ; the partition never blocks
- Tests with a real Kafka (`npm run test:e2e:inventory`, and the saga suite in `npm run test:e2e:order`): same event 3×, 100 buyers for 10 items, opposite lock order, poison → DLQ, DB error → retry → success, late events ignored by the state machine
- Decision record: [ADR 0001 — choreography saga](docs/adr/0001-choreography-saga.md)

### DLQ runbook

1. Kafka UI → topic `<group>.dlq` → read the `x-error` and `x-dlq-reason` headers.
2. Fix the cause (bug, data, config).
3. `npm run dlq:replay -- <group>` sends the messages back to their original topic (`--include-poison` once a code fix can handle them).

## Payments (F6)

```
PENDING ──webhook success──► SUCCEEDED ──order.cancelled──► REFUND_PENDING ──► REFUNDED
   │                                                              ▲
   └──timeout (sweeper)──► EXPIRED ──late webhook success─────────┘
```

- **Providers**: `PAYMENT_PROVIDER=fake | razorpay | stripe`. One `PaymentProvider` interface (Strategy), one adapter per provider (Adapter), picked by `PaymentProviderFactory`. `fake` is for dev and tests only and is refused in production.
- **Checkout**: `POST /v1/payments/:orderId/checkout` returns what the frontend needs to open the provider's checkout. Calling it again resumes the same provider order. Every provider call goes through `@app/resilience`: 2 s timeout per attempt, 2 retries with backoff + jitter (temporary errors only), and a circuit breaker per provider (≥ 50 % of ≥ 5 calls fail → fail fast for 30 s). The gateway allows 10 s for `/v1/payments`, above that ~6.6 s worst case.
- **Webhooks**: `POST /v1/payments/webhooks/:provider`, no JWT. HMAC over the raw body (wrong → 401); deduplicated by `(provider, event id)` in the same transaction as the change; no per-IP rate limit. A non-2xx (e.g. 503 for an unknown provider order) makes the provider send it again.
- **A declined card is not a failed payment**: the user can try again until `expires_at` (`PAYMENT_TTL_MINUTES`, 15). Only the expiry is final.
- **Sweeper** (`PAYMENT_SWEEP_MS`, 30 s, every pod): `FOR UPDATE SKIP LOCKED` expires due payments (→ `payment.failed`) and retries pending refunds. Webhook and sweeper both lock the row first, so a payment ends in exactly one final state; a success that arrives after the expiry is refunded automatically.
- **Refunds**: a 2-minute lease (`refund_attempted_at`), the provider call outside any transaction, then a conditional `REFUND_PENDING → REFUNDED` (+ `payment.refunded`). The payment id is the provider's idempotency key.
- Dev only: `POST /v1/payments/dev/fake-mode` (`ok` / `fail` / `slow` / `flaky`) and `GET /v1/payments/dev/circuits`.
- Tests (`npm run test:e2e:payment`): signatures, dedupe, declined attempts, expiry, late success → refund, refund lease, **webhook vs timeout racing 20×** (always one outcome, one refund per lost race), circuit breaker opening, timeouts, compensation.
- Decision record: [ADR 0002: payment providers, webhooks, auto-refund](docs/adr/0002-payment-providers-and-refunds.md)

### Saga end to end

**Order owns the order status**: Inventory and Payment react to `order.*` events, never to each other.

| Event                        | Order     | Inventory                       | Payment                            |
| ---------------------------- | --------- | ------------------------------- | ---------------------------------- |
| `order.created`              | PENDING   | reserve                         | –                                  |
| `stock.reserved`             | CONFIRMED | –                               | create payment (`order.confirmed`) |
| `payment.succeeded`          | PAID      | commit (via `order.paid`)       | –                                  |
| `payment.failed`             | CANCELLED | release (via `order.cancelled`) | –                                  |
| `order.cancelled` after paid | –         | – (already sold)                | refund                             |

Compensation is idempotent twice over: `processed_events` drops redelivered events, and only `RESERVED` reservations can be committed or released, so even a second, different cancel event changes nothing.

## Notifications (F7)

```
order-/payment-events ─▶ NotificationsConsumer ─┬─ order.created ─▶ Mongo orders_view (projection)
                                                └─ other events ─▶ Command ─▶ BullMQ "notifications"
BullMQ ─▶ worker (5 at once, ≤ 10/s) ─▶ handler ─▶ EmailSender (SMTP → Mailpit; SES later)
                                                 └─▶ Mongo notification_logs: QUEUED → SENT / FAILED
```

| Event              | Email                          |
| ------------------ | ------------------------------ |
| `order.paid`       | Order confirmed                |
| `order.cancelled`  | Order cancelled (+ the reason) |
| `order.failed`     | We could not place the order   |
| `payment.refunded` | Your refund is on the way      |

- **Local projection**: notification never calls the order or user service. The buyer's email is snapshotted on the order at checkout and sent in `order.created` (an optional field, so still version 1).
- **Command pattern**: the planner turns an event into commands (`SendEmailCommand`); the worker runs the handler for the job name. A new channel (SMS) = one command + one handler.
- **Why a queue between Kafka and SMTP**: Kafka is acknowledged fast, a slow mail server can't stall a partition, and each email retries on its own schedule.
- **Dedupe**: BullMQ `jobId = <eventId>-<channel>-<template>` + a unique log key. The job is queued _before_ the log is written, so a crash in between loses nothing.
- **Retries**: 4 attempts with exponential backoff (2 s, 4 s, 8 s; `NOTIFY_BACKOFF_MS`). SMTP 5xx or an unknown template → `FAILED` at once. Delivery is at least once: the worker skips jobs already `SENT`, but SMTP has no idempotency key.
- **No replay on deploy**: the consumer group starts from now (`fromBeginning = false`), so a new deploy doesn't email customers about old orders.
- **Ops**: Mailpit at http://localhost:8025, Bull Board at http://localhost:3006/v1/queues (dev only: it can retry and delete jobs), and `GET /v1/notifications?orderId=` (admin) shows what was sent.
- Tests (`npm run test:e2e:notification`): projection, one email per event (×3 duplicates), every template, HTML escaping, SMTP down → 4 attempts → `FAILED` → retry → `SENT`, flaky → `SENT`, SMTP 550 → `FAILED` after 1 attempt, no email address, unknown order → DLQ, admin-only log endpoint.

## Scheduled jobs (F8)

| Job                  | Service   | When (UTC)          | What                                                                                               |
| -------------------- | --------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `order-expiry`       | order     | every minute at :00 | PENDING > 10 min → CANCELLED (`STOCK_TIMEOUT`); CONFIRMED > 30 min → CANCELLED (`PAYMENT_TIMEOUT`) |
| `reservation-expiry` | inventory | every minute at :30 | holds past their 60 min expiry → released (+ `stock.released`, `HOLD_EXPIRED`)                     |
| `order-housekeeping` | order     | hourly at :15       | deletes outbox rows published > 7 days ago, `processed_events` > 14 days, idempotency keys > 1 day |
| payment sweeper      | payment   | every 30 s          | expires PENDING payments, retries refunds (every pod runs it; `SKIP LOCKED` splits the rows)       |

An expired order needs nothing else: its `order.cancelled` makes inventory release the stock, payment close or refund, and notification send the email.

**Safe with many pods** (`libs/scheduler`, `LeaderJob`):

- **Efficiency: a Redis lock** per job, so one pod runs each tick. `SET NX PX` (atomic, with a TTL, so a crashed holder can't block it forever), an owner token, and Lua compare-and-renew / compare-and-release (a slow pod can't free someone else's lock). A heartbeat renews it at TTL/3; if renewal fails, `ctx.lost` tells the job to stop after the current batch. After a run the lock is kept until 1 s before the next tick: pods' timers fire a few ms apart, and a freed lock would let a late pod run the same tick again. A `running` flag stops overlap inside one pod.
- **Correctness: the database.** Every change is made in small batches with `FOR UPDATE SKIP LOCKED` and the order state machine, so even two pods running at once (lock lost to a GC pause, a network split) change each row once.
- Crons have 6 fields (seconds first) and run in UTC. `JOBS_ENABLED=false` turns them off (tests call `tick()` themselves); `*_CRON` env vars override the schedules.

**Timing contract**: the timers must nest, or a service acts on stale state:

```
payment TTL (15 min)  <  order CONFIRMED timeout (30 min)    payment decides; order is the backstop
order max life (10 + 30 = 40 min)  <  reservation hold (60 min)    stock is never released for an order that can still be paid
```

If the hold ever ends first anyway, paying that order logs `ALERT: order … is PAID but has no RESERVED reservation`.

Tests (`npm run test:e2e:order`, `npm run test:e2e:inventory`): **3 copies of the order service** run the expiry job together and cancel each of 300 stale orders exactly once; the same **without the lock** (DB fencing alone); only stale orders are touched; one of 3 simultaneous ticks runs; overlap in one pod; renewal on a job longer than the TTL; takeover after a crashed holder; a stolen lock stops the job without deleting the new owner's lock; two racing hold-expiry runs release once.

Decision record: [ADR 0003: Redis lock for efficiency, database for correctness](docs/adr/0003-distributed-locks.md)

## Scripts

| Command                                                                       | Description                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                                                               | Build (gateway by default)                                         |
| `npm run start:dev`                                                           | Start in watch mode (gateway by default)                           |
| `npm run start:prod`                                                          | Run the built gateway                                              |
| `npm run lint`                                                                | Lint and auto-fix with ESLint                                      |
| `npm run format`                                                              | Format `apps/` and `libs/` with Prettier                           |
| `npm test`                                                                    | Run unit tests (Jest)                                              |
| `npm run test:cov`                                                            | Run unit tests with coverage                                       |
| `npm run test:e2e`                                                            | Run integration tests (needs Docker)                               |
| `npm run migration:run:user`                                                  | Apply user service migrations                                      |
| `npm run migration:generate:user -- apps/user/src/database/migrations/<Name>` | Generate a migration from entity changes                           |
| `npm run migration:run:order`                                                 | Apply order service migrations                                     |
| `npm run seed:product`                                                        | Load 60 sample products (dev only)                                 |
| `npm run proto:gen`                                                           | Regenerate types from `libs/proto/src/*.proto` (commit the result) |
| `npm run kafka:topics`                                                        | Create the Kafka topics (idempotent; `KAFKA_RF=3` in production)   |
| `npm run dlq:replay -- <group>`                                               | Send a consumer group's dead letters back to their topic           |
| `node scripts/upload-image.js <productId> <file> <adminToken>`                | Upload a product image via presigned POST                          |

Append a project name to the build/start scripts to target one service, e.g. `npm run start:dev -- order`.

## License

UNLICENSED — private project.
