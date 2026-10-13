import type { NextFunction, Request, Response } from 'express';
import { httpDuration } from './metrics';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;
const NUMBER = /\/\d+(?=\/|$)/g;

/** /v1/orders/3f2a…/tracking → /v1/orders/:id/tracking */
export function normalizePath(url: string) {
  return url
    .split('?')[0]
    .replace(UUID, ':id')
    .replace(OBJECT_ID, ':id')
    .replace(NUMBER, '/:n');
}

/** RED metrics for every request (not /metrics or /health). */
export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.path === '/metrics' || req.path.startsWith('/health')) return next();
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    // CARDINALITY: never a raw URL in a label. Each distinct value is a new
    // time series; a bot hitting /random-1, /random-2… would make millions
    // and Prometheus would run out of memory.
    const route = (req.route as { path?: string } | undefined)?.path
      ? `${req.baseUrl ?? ''}${(req.route as { path: string }).path}` // the template: /v1/orders/:id
      : res.statusCode === 404
        ? 'unmatched'
        : normalizePath(req.originalUrl); // e.g. the gateway's proxied paths
    stop({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
}
