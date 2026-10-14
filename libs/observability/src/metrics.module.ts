import { Controller, Get, Header, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { registry } from './metrics';

/**
 * GET /metrics for Prometheus (outside the v1 prefix, like /health). For the
 * internal network only: never routed through the gateway, and blocked at
 * the edge in production (the gateway's own /metrics included).
 */
@ApiExcludeController()
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
