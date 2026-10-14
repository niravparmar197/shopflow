import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import {
  httpMetricsMiddleware,
  normalizePath,
} from './http-metrics.middleware';
import { registry } from './metrics';

/** Runs the middleware on a fake request and returns the route label used. */
async function routeLabelFor(req: Partial<Request>, status: number) {
  registry.resetMetrics();
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  httpMetricsMiddleware(
    { path: '/x', method: 'GET', baseUrl: '', ...req } as Request,
    res as unknown as Response,
    (() => undefined) as NextFunction,
  );
  res.emit('finish');
  const text = await registry.metrics();
  return text.match(
    /http_server_request_duration_seconds_count\{[^}]*route="([^"]*)"/,
  )?.[1];
}

describe('HTTP metrics labels (cardinality)', () => {
  it('normalises ids in paths', () => {
    expect(
      normalizePath(
        '/v1/orders/3f2a1b4c-1111-4222-8333-444455556666/tracking?x=1',
      ),
    ).toBe('/v1/orders/:id/tracking');
    expect(normalizePath('/v1/products/6ace0aac14ce048f0040452d')).toBe(
      '/v1/products/:id',
    );
    expect(normalizePath('/v1/items/42')).toBe('/v1/items/:n');
  });

  it('a controller route → its template, even for a 404 (order not found)', async () => {
    const req = {
      route: { path: '/v1/orders/:id' },
      originalUrl: '/v1/orders/abc',
    };
    expect(await routeLabelFor(req, 200)).toBe('/v1/orders/:id');
    expect(await routeLabelFor(req, 404)).toBe('/v1/orders/:id');
  });

  it('gateway middleware (real path in baseUrl) → normalised, never the raw id', async () => {
    const id = '3f2a1b4c-1111-4222-8333-444455556666';
    const label = await routeLabelFor(
      {
        route: { path: '{/*splat}' },
        baseUrl: `/v1/orders/${id}`,
        originalUrl: `/v1/orders/${id}`,
      },
      200,
    );
    expect(label).toBe('/v1/orders/:id');
  });

  it('random URLs that 404 → one "unmatched" series', async () => {
    expect(await routeLabelFor({ originalUrl: '/random-123' }, 404)).toBe(
      'unmatched',
    );
    expect(
      await routeLabelFor(
        { route: { path: '{/*splat}' }, originalUrl: '/random-456' },
        404,
      ),
    ).toBe('unmatched');
  });

  it('/metrics and /health are not measured', async () => {
    registry.resetMetrics();
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = jest.fn();
    httpMetricsMiddleware(
      { path: '/metrics' } as Request,
      res as unknown as Response,
      next,
    );
    res.emit('finish');
    expect(next).toHaveBeenCalled();
    expect(await registry.metrics()).not.toMatch(
      /http_server_request_duration_seconds_count\{/,
    );
  });
});
