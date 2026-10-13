import { Logger } from '@nestjs/common';
import { sendError } from '@app/common';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

const logger = new Logger('RateLimit');

export interface RateLimitOptions {
  prefix: string;
  points: number; // allowed requests
  durationSec: number; // per this many seconds
  message: string;
}

// Counters live in Redis, so the limit holds across every gateway instance.
export function createRateLimiter(redis: Redis, opts: RateLimitOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: opts.prefix,
    points: opts.points,
    duration: opts.durationSec,
  });

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await limiter.consume(req.ip ?? 'unknown');
      res.setHeader('X-RateLimit-Limit', opts.points);
      res.setHeader('X-RateLimit-Remaining', result.remainingPoints);
      next();
    } catch (err: unknown) {
      if (err instanceof RateLimiterRes) {
        res.setHeader('Retry-After', Math.ceil(err.msBeforeNext / 1000));
        return sendError(req, res, 429, opts.message);
      }
      // Redis is down: fail open so the shop keeps working, but log it
      // loudly so an alert fires.
      logger.error({ err }, `Rate limiter ${opts.prefix} unavailable`);
      next();
    }
  };
}
