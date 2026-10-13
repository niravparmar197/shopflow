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

  USER_SERVICE_URL: z.string().min(1).optional(),
  PRODUCT_SERVICE_URL: z.string().min(1).optional(),
  ORDER_SERVICE_URL: z.string().min(1).optional(),
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
