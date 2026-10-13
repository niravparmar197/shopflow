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
}

export async function bootstrapService(
  rootModule: Type<unknown>,
  { globalPrefix, bodyParser = true, configure }: BootstrapOptions = {},
) {
  const app = await NestFactory.create(rootModule, {
    bufferLogs: true,
    bodyParser,
  });
  app.useLogger(app.get(Logger));
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
  app.enableShutdownHooks();
  configure?.(app);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app
    .get(Logger)
    .log(
      `${config.get('SERVICE_NAME', { infer: true })} listening on port ${port}`,
    );
  return app;
}
