# ShopFlow

Event-driven e-commerce backend: 6 NestJS microservices + API gateway,
gRPC, Kafka (saga + outbox), PostgreSQL, MongoDB, Redis, deployed on AWS.

## Run locally
```bash
cd infra && docker compose up -d
npm install
npm run start:dev gateway
```

Each service reads its config from `apps/<service>/.env`. Copy `apps/<service>/.env.example` to `.env` and fill in the credentials first.

Every service exposes `GET /health/live` and `GET /health/ready`.

## Ports
| Service | Port |
|---|---|
| gateway | 3000 |
| user | 3001 |
| product | 3002 |
| order | 3003 |
| payment | 3004 |
| inventory | 3005 |
| notification | 3006 |
| Kafka UI | 8081 |
| Grafana | 3010 |
| Prometheus | 9091 |
| Jaeger | 16686 |
| Mailpit | 8025 |

## Shared libraries

Imported via TypeScript path aliases (see `tsconfig.json`).

| Library  | Alias          | Purpose (planned)                          |
| -------- | -------------- | ------------------------------------------ |
| `common` | `@app/common`  | Env validation, logging, health checks, bootstrap |
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
