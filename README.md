# ShopFlow

An e-commerce backend built as a set of [NestJS](https://nestjs.com/) microservices in a single monorepo.

> **Status:** early scaffold. Each service and shared library has been generated with the Nest CLI, but no business logic, messaging, or persistence is implemented yet.

## Services

| Service        | Path                 | Default port | Responsibility (planned)                          |
| -------------- | -------------------- | ------------ | ------------------------------------------------- |
| `gateway`      | `apps/gateway`       | 3000         | Public HTTP entry point; routes to other services |
| `user`         | `apps/user`          | 3001         | Accounts, authentication, profiles                |
| `product`      | `apps/product`       | 3002         | Product catalog                                   |
| `inventory`    | `apps/inventory`     | 3003         | Stock levels and reservations                     |
| `order`        | `apps/order`         | 3004         | Order creation and lifecycle                      |
| `payment`      | `apps/payment`       | 3005         | Payment processing                                |
| `notification` | `apps/notification`  | 3006         | Email / SMS / push notifications                  |

`gateway` is the default project, so Nest CLI commands without a project name target it.

## Shared libraries

Imported via TypeScript path aliases (see `tsconfig.json`).

| Library  | Alias          | Purpose (planned)                          |
| -------- | -------------- | ------------------------------------------ |
| `common` | `@app/common`  | Shared utilities, DTOs, guards, filters    |
| `events` | `@app/events`  | Event names and payload contracts          |
| `kafka`  | `@app/kafka`   | Kafka client/producer/consumer wiring      |
| `proto`  | `@app/proto`   | gRPC protobuf definitions                  |

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

- Node.js 20+
- npm

### Install

```bash
npm install
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

## Scripts

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `npm run build`      | Build (gateway by default)               |
| `npm run start:dev`  | Start in watch mode (gateway by default) |
| `npm run start:prod` | Run the built gateway                    |
| `npm run lint`       | Lint and auto-fix with ESLint            |
| `npm run format`     | Format `apps/` and `libs/` with Prettier |
| `npm test`           | Run unit tests (Jest)                    |
| `npm run test:cov`   | Run unit tests with coverage             |
| `npm run test:e2e`   | Run gateway end-to-end tests             |

Append a project name to the build/start scripts to target one service, e.g. `npm run start:dev -- order`.

## License

UNLICENSED — private project.
