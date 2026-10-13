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
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.url().optional(),
  MONGO_URL: z.url().optional(),
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
  MAIL_FROM: z.string().min(1).default('ShopFlow <no-reply@shopflow.local>'),
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
  NOTIFICATION_SERVICE_URL: z.url().optional(),

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
