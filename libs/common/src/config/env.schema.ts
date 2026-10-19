import { z } from 'zod';

// `KEY=` (empty, as in .env.example) counts as not set.
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => v || undefined);

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive(),
  // Pending connections the OS queues before refusing more (Node's default
  // is 511). A burst of new connections bigger than this is refused.
  HTTP_LISTEN_BACKLOG: z.coerce.number().int().positive().default(511),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.url().optional(),
  // Path to a CA bundle: turns on verified TLS to Postgres (Stage 2 RDS).
  DATABASE_SSL_CA: z.string().min(1).optional(),
  MONGO_URL: z.url().optional(),
  // Build Mongo indexes on startup. Default: on outside production, off in
  // production (a big collection can lock while building). Stage 1 turns it on
  // on purpose: tiny collections, and the unique indexes ARE the dedupe.
  MONGO_AUTO_INDEX: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  REDIS_URL: z.url().optional(),
  KAFKA_BROKERS: z.string().min(1).optional(), // comma-separated host:port
  // Outbox relay (libs/kafka). Off in tests, which run without Kafka.
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Kafka consumers (libs/kafka BaseConsumer). Off in tests without Kafka.
  KAFKA_CONSUMERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Scheduled jobs (libs/scheduler). Off in tests, which call tick() by hand.
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // 6-field cron (seconds first), UTC. Unset → the job's default.
  HOUSEKEEPING_CRON: z.string().min(1).optional(),
  ORDER_EXPIRY_CRON: z.string().min(1).optional(),
  RESERVATION_EXPIRY_CRON: z.string().min(1).optional(),
  // The TIMING CONTRACT (README "Auto-cancel"): payment TTL (15) < confirmed
  // timeout (30), and the order's max life (10 + 30) < the hold (60), so
  // inventory never releases stock for an order that can still be paid.
  ORDER_PENDING_TIMEOUT_MIN: z.coerce.number().int().positive().default(10),
  ORDER_CONFIRMED_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
  RESERVATION_HOLD_MINUTES: z.coerce.number().int().positive().default(60),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  // The web app's address, for links in emails (reset password, verify).
  WEB_URL: z.url().default('http://localhost:5000'),
  MAIL_FROM: z.string().min(1).default('ShopFlow <no-reply@shopflow.local>'),
  // Who sends the emails: SMTP (Mailpit locally) or Amazon SES (Phase 2 P4).
  // SES uses the AWS role of the box / task; MAIL_FROM must be verified in SES.
  EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
  SES_REGION: z.string().min(1).default('ap-southeast-2'),
  // GST invoices (order service, Phase 2 P4). Demo seller: not a real GSTIN.
  SELLER_NAME: z.string().min(1).default('ShopFlow Retail (demo)'),
  SELLER_ADDRESS: z
    .string()
    .min(1)
    .default('12, SG Highway, Ahmedabad, Gujarat 380015'),
  SELLER_STATE: z.string().min(1).default('Gujarat'),
  SELLER_GSTIN: z.string().min(1).default('24AAACS1234F1Z5'),
  // Prices include GST at this one rate (a real shop sets it per product).
  GST_RATE_PERCENT: z.coerce.number().min(0).max(28).default(18),
  // First retry delay for notification jobs (then ×2). Tests use ~100 ms.
  NOTIFY_BACKOFF_MS: z.coerce.number().int().positive().default(2_000),

  // The user service signs with the private key; everyone verifies with the public one.
  JWT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  GRPC_PORT: z.coerce.number().int().positive().optional(), // this service's gRPC server
  PRODUCT_GRPC_URL: z.string().min(1).optional(), // host:port, no scheme

  // Object storage. S3_ENDPOINT is only set for MinIO locally; on AWS the SDK
  // uses the real S3 endpoint and the IAM role's credentials.
  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('ap-south-1'),
  S3_ENDPOINT: z.url().optional(),
  ASSET_BASE_URL: z.url().optional(), // public base for image keys (CDN on AWS)
  // Local only (MinIO). Listed so ConfigModule copies them from .env into
  // process.env, where the AWS SDK looks; unset on AWS (IAM role instead).
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  // Payments (payment service). Keys only ever in .env, never committed.
  PAYMENT_PROVIDER: z.enum(['razorpay', 'stripe', 'fake']).default('fake'),
  PAYMENT_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  // Expiry + refund-retry job. Every pod runs it (SKIP LOCKED splits the rows).
  PAYMENT_SWEEPER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENT_SWEEP_MS: z.coerce.number().int().positive().default(30_000),
  RAZORPAY_KEY_ID: optionalSecret,
  RAZORPAY_KEY_SECRET: optionalSecret,
  RAZORPAY_WEBHOOK_SECRET: optionalSecret,
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_PUBLISHABLE_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  FAKE_WEBHOOK_SECRET: optionalSecret,

  // Service-to-service calls (order → inventory /internal/*). Never sent
  // through the gateway. Production: private network + mTLS (F11).
  INTERNAL_API_TOKEN: optionalSecret,
  // Order → inventory flash-sale gate: calls in flight, and waiting.
  FLASH_BULKHEAD_MAX: z.coerce.number().int().positive().default(50),
  FLASH_BULKHEAD_QUEUE: z.coerce.number().int().nonnegative().default(200),

  USER_SERVICE_URL: z.url().optional(),
  PRODUCT_SERVICE_URL: z.url().optional(),
  ORDER_SERVICE_URL: z.url().optional(),
  INVENTORY_SERVICE_URL: z.url().optional(),
  PAYMENT_SERVICE_URL: z.url().optional(),
  // Blue-green for payment: PAYMENT_SERVICE_URL is BLUE, this is GREEN.
  // The gateway sends all users to PAYMENT_LIVE_COLOR. Empty = blue only.
  PAYMENT_GREEN_URL: optionalSecret,
  PAYMENT_LIVE_COLOR: z.enum(['blue', 'green']).default('blue'),
  // Lets a tester reach the IDLE colour (x-deploy-color + x-preview-token).
  // Unset = no preview possible.
  PREVIEW_TOKEN: optionalSecret,
  NOTIFICATION_SERVICE_URL: z.url().optional(),

  // Gateway: requests per minute per client IP. Raise it ONLY for a local
  // load test (k6 sends 1,000 users from one IP); never trust a client's
  // X-Forwarded-For to get around it.
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(100),
  // Gateway behind a reverse proxy (Caddy on Stage 1, ALB on Stage 2): how many
  // proxy hops to trust for X-Forwarded-For, so req.ip is the real client and
  // not the proxy (otherwise every user shares ONE rate-limit bucket).
  // 0 = no proxy (local). Never set it higher than the real number of hops,
  // or a client can spoof its IP with its own X-Forwarded-For header.
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  // OpenAPI: each service serves /docs/openapi.json, the gateway the UI at /docs.
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Comma-separated browser origins allowed to call the API with cookies.
  CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
