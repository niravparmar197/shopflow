import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Env, OPENAPI_JSON_PATH, sendError } from '@app/common';

/** The services whose specs the docs page offers, in dropdown order. */
const SERVICES = [
  { key: 'user', name: 'User & Auth', env: 'USER_SERVICE_URL' },
  { key: 'order', name: 'Orders & Cart', env: 'ORDER_SERVICE_URL' },
  { key: 'payment', name: 'Payments', env: 'PAYMENT_SERVICE_URL' },
  { key: 'product', name: 'Products (admin)', env: 'PRODUCT_SERVICE_URL' },
  { key: 'inventory', name: 'Inventory (admin)', env: 'INVENTORY_SERVICE_URL' },
  {
    key: 'notification',
    name: 'Notifications (admin)',
    env: 'NOTIFICATION_SERVICE_URL',
  },
] as const satisfies readonly { key: string; name: string; env: keyof Env }[];

const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;

/**
 * One Swagger UI at /docs with a dropdown of every service's spec. Each
 * service describes itself (GET /docs/openapi.json); the gateway only fetches
 * and caches them, so a service being down never breaks the page. "Try it
 * out" calls go to the gateway's /v1 routes: real JWT checks, rate limits.
 */
export function setupGatewayDocs(app: INestApplication) {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  if (!config.get('SWAGGER_ENABLED', { infer: true })) return;

  const logger = new Logger('Docs');
  const http = app.getHttpAdapter();
  const cache = new Map<string, { at: number; body: unknown }>();

  // 1. The gateway's own routes (public product reads over gRPC).
  const gatewayDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ShopFlow – Gateway')
      .setVersion(process.env.APP_VERSION ?? 'dev')
      .addBearerAuth()
      .build(),
  );
  http.get('/docs/specs/gateway.json', (_req: Request, res: Response) =>
    res.json(gatewayDoc),
  );

  // 2. Each service's spec: fetched, cached, stale on failure.
  http.get('/docs/specs/:file', async (req: Request, res: Response) => {
    const key = String(req.params.file).replace(/\.json$/, '');
    const svc = SERVICES.find((s) => s.key === key);
    const base = svc && config.get(svc.env, { infer: true });
    if (!svc || !base) {
      return sendError(req, res, 404, 'Unknown service', { code: 'NO_SPEC' });
    }

    const hit = cache.get(svc.key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
    try {
      const r = await fetch(`${base}${OPENAPI_JSON_PATH}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body: unknown = await r.json();
      cache.set(svc.key, { at: Date.now(), body });
      return res.json(body);
    } catch (err) {
      logger.warn(`Spec for ${svc.key} unavailable: ${(err as Error).message}`);
      if (hit) return res.json(hit.body); // stale is better than nothing
      return sendError(req, res, 502, `${svc.name} is not reachable`, {
        code: 'SPEC_UNAVAILABLE',
      });
    }
  });

  // 3. The UI, with a dropdown of all specs.
  SwaggerModule.setup('docs', app, gatewayDoc, {
    explorer: true,
    customSiteTitle: 'ShopFlow API',
    swaggerOptions: {
      urls: [
        { url: '/docs/specs/gateway.json', name: 'Gateway (products)' },
        ...SERVICES.map((s) => ({
          url: `/docs/specs/${s.key}.json`,
          name: s.name,
        })),
      ],
      persistAuthorization: true, // keep the JWT after a reload or spec switch
    },
  });
}
