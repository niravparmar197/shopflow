import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { httpMetricsMiddleware, initMetrics } from '@app/observability';
import { Logger } from 'nestjs-pino';
import { Env } from './config/env.schema';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { setupServiceSwagger } from './swagger/setup-service-swagger';

export interface BootstrapOptions {
  /** Route prefix such as 'v1'. Health checks stay unprefixed. */
  globalPrefix?: string;
  /** Set false when the service streams bodies through untouched (gateway). */
  bodyParser?: boolean;
  /** Keep the request's original bytes in req.rawBody (webhook signatures). */
  rawBody?: boolean;
  /** Publish this service's OpenAPI spec under this title (gateway shows it). */
  swagger?: { title: string };
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
  { globalPrefix, swagger, configure }: BootstrapOptions = {},
) {
  // Metrics: every metric labelled with this service; RED per route.
  initMetrics(
    app.get<ConfigService<Env, true>>(ConfigService).get('SERVICE_NAME', {
      infer: true,
    }),
  );
  app.use(httpMetricsMiddleware);
  app.use(helmet());
  if (globalPrefix) {
    app.setGlobalPrefix(globalPrefix, {
      exclude: ['health/live', 'health/ready', 'metrics'],
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
  if (swagger) setupServiceSwagger(app, swagger.title); // after the prefix
  configure?.(app);
}

export async function bootstrapService(
  rootModule: Type<unknown>,
  options: BootstrapOptions = {},
) {
  const app = await NestFactory.create(rootModule, {
    bufferLogs: true,
    bodyParser: options.bodyParser ?? true,
    rawBody: options.rawBody ?? false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, options);
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await options.beforeListen?.(app);
  // Nest passes extra arguments on to Node's server.listen(), where a number
  // after the port is the backlog; Nest's typings just don't list it.
  const listen = app.listen.bind(app) as (
    port: number,
    backlog: number,
  ) => Promise<unknown>;
  await listen(port, config.get('HTTP_LISTEN_BACKLOG', { infer: true }));
  app
    .get(Logger)
    .log(
      `${config.get('SERVICE_NAME', { infer: true })} listening on port ${port}`,
    );
  return app;
}
