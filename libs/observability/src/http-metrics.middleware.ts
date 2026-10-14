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

/** RED metrics for every request (not /metrics, /health or /docs). */
export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (
    req.path === '/metrics' ||
    req.path.startsWith('/health') ||
    req.path.startsWith('/docs')
  ) {
    return next();
  }
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    // CARDINALITY: never a raw URL in a label. Each distinct value is a new
    // time series; a bot hitting /random-1, /random-2… would make millions
    // and Prometheus would run out of memory.
    // A controller route gives its template (/v1/orders/:id). Middleware
    // mounted on a path (the gateway's proxies) has the REAL path in
    // baseUrl, so that one is normalised instead.
    // A wildcard ({/*splat}, from catch-all middleware) is not a real route.
    const routePath = (req.route as { path?: string } | undefined)?.path;
    const template =
      routePath && !routePath.includes('*') ? routePath : undefined;
    const route =
      template && !req.baseUrl
        ? template // even for a 404 like "order not found"
        : res.statusCode === 404
          ? 'unmatched' // a flood of random URLs stays ONE series
          : normalizePath(req.originalUrl);
    stop({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
}
