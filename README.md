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

| Library  | Alias         | Purpose (planned)                       |
| -------- | ------------- | --------------------------------------- |
| `common` | `@app/common` | Shared utilities, DTOs, guards, filters |
| `events` | `@app/events` | Event names and payload contracts       |
| `kafka`  | `@app/kafka`  | Kafka client/producer/consumer wiring   |
| `proto`  | `@app/proto`  | gRPC protobuf definitions               |

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
| `node scripts/upload-image.js <productId> <file> <adminToken>`                | Upload a product image via presigned POST                          |

Append a project name to the build/start scripts to target one service, e.g. `npm run start:dev -- order`.

## License

UNLICENSED — private project.
