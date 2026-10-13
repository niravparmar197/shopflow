import { ConfigService } from '@nestjs/config';
import { bootstrapService, Env } from '@app/common';
import { GatewayModule } from './gateway.module';

void bootstrapService(GatewayModule, {
  // The gateway never reads bodies; it streams them to the services.
  bodyParser: false,
  configure: (app) => {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const origins = (config.get('CORS_ORIGINS', { infer: true }) ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.enableCors({ origin: origins, credentials: true }); // allow the refresh cookie
  },
});
