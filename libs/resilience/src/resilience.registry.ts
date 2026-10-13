import {
  Global,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  type CircuitState,
  DEFAULT_RESILIENCE,
  type ResilienceOptions,
  ResilientExecutor,
} from './resilient-executor';

/** One executor (= one breaker) per dependency name, shared by the app. */
@Injectable()
export class ResilienceRegistry implements OnApplicationShutdown {
  private readonly executors = new Map<string, ResilientExecutor>();

  /** Options apply on first use only; later calls get the same executor. */
  for(name: string, opts: Partial<ResilienceOptions> = {}): ResilientExecutor {
    let ex = this.executors.get(name);
    if (!ex) {
      ex = new ResilientExecutor(name, { ...DEFAULT_RESILIENCE, ...opts });
      this.executors.set(name, ex);
    }
    return ex;
  }

  states(): Record<string, CircuitState> {
    return Object.fromEntries(
      [...this.executors].map(([n, e]) => [n, e.state]),
    );
  }

  onApplicationShutdown() {
    this.executors.forEach((e) => e.shutdown());
  }
}

@Global()
@Module({ providers: [ResilienceRegistry], exports: [ResilienceRegistry] })
export class ResilienceModule {}
