import { z } from 'zod';

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
  KAFKA_BROKERS: z.string().min(1).optional(),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),

  // The user service signs with the private key; everyone verifies with the public one.
  JWT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  USER_SERVICE_URL: z.url().optional(),
  PRODUCT_SERVICE_URL: z.url().optional(),
  ORDER_SERVICE_URL: z.url().optional(),

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
