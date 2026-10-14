import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Env } from '../config/env.schema';

/** Where each service serves its spec; the gateway fetches it from here. */
export const OPENAPI_JSON_PATH = '/docs/openapi.json';

/**
 * Each service publishes ONLY its JSON spec; the UI lives on the gateway,
 * whose "Try it out" calls go through the real gateway (JWT, rate limits).
 * Call after setGlobalPrefix, so the paths include /v1.
 */
export function setupServiceSwagger(app: INestApplication, title: string) {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  if (!config.get('SWAGGER_ENABLED', { infer: true })) return;

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`ShopFlow – ${title}`)
      .setVersion(process.env.APP_VERSION ?? 'dev')
      .addBearerAuth() // the "Authorize" button for the JWT
      .build(),
  );
  app
    .getHttpAdapter()
    .get(OPENAPI_JSON_PATH, (_req: Request, res: Response) => res.json(doc));
}
