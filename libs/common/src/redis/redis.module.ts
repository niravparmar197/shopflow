import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}

/** One shared Redis connection per service, injected with @Inject(REDIS). */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const redis = new Redis(
          config.getOrThrow('REDIS_URL', { infer: true }),
          {
            // Fail fast while Redis is down instead of queueing commands, so
            // callers can fail open rather than hang every request.
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          },
        );
        const logger = new Logger('Redis');
        redis.on('error', (err) =>
          logger.warn({ err }, 'Redis connection error'),
        );
        return redis;
      },
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
