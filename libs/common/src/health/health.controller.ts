import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';

const HEAP_LIMIT_BYTES = 512 * 1024 * 1024;

// On SIGTERM (ECS / compose stopping the container) readiness turns "no" at
// once, so the load balancer drains this target while enableShutdownHooks()
// finishes in-flight work and closes connections. Liveness stays "yes": the
// process is still healthy, just leaving.
let shuttingDown = false;
process.once('SIGTERM', () => {
  shuttingDown = true;
});

@ApiExcludeController() // ops, not API
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  // Liveness: the process is up and serving requests.
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  // Readiness: the service can take traffic. Dependency checks
  // (database, Redis, Kafka) get added here as services wire them in.
  @Get('ready')
  @HealthCheck()
  ready() {
    if (shuttingDown) {
      throw new ServiceUnavailableException({
        code: 'SHUTTING_DOWN',
        message: 'Draining',
      });
    }
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', HEAP_LIMIT_BYTES),
    ]);
  }
}
