import { Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { Env } from './config/env.schema';

export async function bootstrapService(rootModule: Type<unknown>) {
  const app = await NestFactory.create(rootModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();

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
