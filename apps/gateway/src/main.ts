import './tracing'; // MUST stay first: see tracing.ts
import { ConfigService } from '@nestjs/config';
import { bootstrapService, Env } from '@app/common';
import { setupGatewayDocs } from './docs/setup-gateway-docs';
import { GatewayModule } from './gateway.module';

void bootstrapService(GatewayModule, {
  // The gateway never reads bodies; it streams them to the services.
  bodyParser: false,
  configure: (app) => {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    // Behind Caddy/ALB: take the client IP from X-Forwarded-For (N hops only).
    const hops = config.get('TRUST_PROXY_HOPS', { infer: true });
    if (hops > 0) {
      const express = app.getHttpAdapter().getInstance() as {
        set(key: string, value: number): void;
      };
      express.set('trust proxy', hops);
    }
    const origins = (config.get('CORS_ORIGINS', { infer: true }) ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.enableCors({
      origin: origins,
      credentials: true, // allow the refresh cookie
      // Request headers (e.g. Idempotency-Key) are allowed by reflecting the
      // preflight; these response headers must be listed for JS to read them.
      exposedHeaders: [
        'Idempotent-Replayed',
        'x-correlation-id',
        'Retry-After',
        'RateLimit-Limit',
        'RateLimit-Remaining',
      ],
    });
    setupGatewayDocs(app); // Swagger UI at /docs, all services' specs
  },
});
