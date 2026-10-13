import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { Env } from './config/env.schema';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';

export interface BootstrapOptions {
  /** Route prefix such as 'v1'. Health checks stay unprefixed. */
  globalPrefix?: string;
  /** Set false when the service streams bodies through untouched (gateway). */
  bodyParser?: boolean;
  /** Service-specific setup (extra middleware etc.), run before listening. */
  configure?: (app: INestApplication) => void;
  /** Async startup work before the HTTP server listens (e.g. a gRPC server). */
  beforeListen?: (app: INestApplication) => Promise<void>;
}

/**
 * Everything a service needs on top of its module: security headers, route
 * prefix, validation, error format. Integration tests call this too, so they
 * exercise exactly what runs in production.
 */
export function configureApp(
  app: INestApplication,
  { globalPrefix, configure }: BootstrapOptions = {},
) {
  app.use(helmet());
  if (globalPrefix) {
    app.setGlobalPrefix(globalPrefix, {
      exclude: ['health/live', 'health/ready'],
    });
  }
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // and reject the request if any were sent
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  configure?.(app);
}

export async function bootstrapService(
  rootModule: Type<unknown>,
  options: BootstrapOptions = {},
) {
  const app = await NestFactory.create(rootModule, {
    bufferLogs: true,
    bodyParser: options.bodyParser ?? true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, options);
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await options.beforeListen?.(app);
  await app.listen(port);
  app
    .get(Logger)
    .log(
      `${config.get('SERVICE_NAME', { infer: true })} listening on port ${port}`,
    );
  return app;
}
