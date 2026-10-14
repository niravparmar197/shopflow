import { Controller, Get, Header, Module } from '@nestjs/common';
import { registry } from './metrics';

/**
 * GET /metrics for Prometheus (outside the v1 prefix, like /health). For the
 * internal network only: never routed through the gateway, and blocked at
 * the edge in production (the gateway's own /metrics included).
 */
@Controller()
class MetricsController {
  @Get('metrics')
  @Header('Content-Type', registry.contentType)
  metrics() {
    return registry.metrics();
  }
}

@Module({ controllers: [MetricsController] })
export class MetricsModule {}
