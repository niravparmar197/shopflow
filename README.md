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
| `node scripts/upload-image.js <productId> <file> <adminToken>`                | Upload a product image via presigned POST                          |

Append a project name to the build/start scripts to target one service, e.g. `npm run start:dev -- order`.

## License

UNLICENSED — private project.
