import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '@app/common';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const redis = new Redis(config.getOrThrow('REDIS_URL', { infer: true }), {
      // Fail fast while Redis is down instead of queueing commands, so the
      // rate limiter can fail open rather than hang every request.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const logger = new Logger('Redis');
    redis.on('error', (err) => logger.warn({ err }, 'Redis connection error'));
    return redis;
  },
};

@Injectable()
export class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit();
  }
}
