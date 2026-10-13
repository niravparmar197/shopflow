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
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  MAIL_FROM: z.string().min(1).default('ShopFlow <no-reply@shopflow.local>'),

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

  USER_SERVICE_URL: z.url().optional(),
  PRODUCT_SERVICE_URL: z.url().optional(),
  ORDER_SERVICE_URL: z.url().optional(),
  INVENTORY_SERVICE_URL: z.url().optional(),
  PAYMENT_SERVICE_URL: z.url().optional(),

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
