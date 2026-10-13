import { Logger } from '@nestjs/common';
import { type AuthenticatedRequest, sendError } from '@app/common';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import { SlidingWindowLimiter, type WindowResult } from './sliding-window';

const logger = new Logger('UserRateLimit');

export interface UserLimitRule {
  /** Part of the Redis key: rl:<name>:<user id>. */
  name: string;
  limit: number;
  windowMs: number;
  /** Default POST only: reads are cheap; writes cost money and stock. */
  methods?: string[];
}

/**
 * Exact per-user limit for expensive WRITE actions (sliding window).
 * Runs AFTER the JWT middleware: the key is the verified user id from the
 * token, never a header the client could set.
 */
export function userRateLimit(redis: Redis, rule: UserLimitRule) {
  const limiter = new SlidingWindowLimiter(redis);
  const methods = rule.methods ?? ['POST'];

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!methods.includes(req.method)) return next();

    const userId = (req as Partial<AuthenticatedRequest>).user?.sub;
    const key = `rl:${rule.name}:${userId ?? `ip:${req.ip}`}`;

    let result: WindowResult;
    try {
      result = await limiter.hit(key, rule.limit, rule.windowMs);
    } catch (err: unknown) {
      // Redis down: FAIL OPEN (as in F1). A broken limiter must not take the
      // shop down; idempotency and the atomic stock update still keep the
      // data right. Logged loudly so an alert fires.
      logger.error({ err }, `Rate limiter ${rule.name} unavailable`);
      return next();
    }

    res.setHeader('RateLimit-Limit', rule.limit);
    res.setHeader('RateLimit-Remaining', result.remaining);
    if (result.allowed) return next();

    // Standard header: clients (and k6) can wait exactly this long.
    res.setHeader(
      'Retry-After',
      Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
    );
    return sendError(req, res, 429, 'Too many requests, slow down', {
      code: 'RATE_LIMITED',
      details: {
        retryAfterMs: result.retryAfterMs,
        limit: rule.limit,
        windowMs: rule.windowMs,
      },
    });
  };
}
