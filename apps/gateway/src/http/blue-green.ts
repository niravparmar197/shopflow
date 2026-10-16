import { counter } from '@app/observability';
import type { NextFunction, Request, Response } from 'express';

/**
 * Blue-green routing at the gateway. Two full deployments of a service exist
 * (blue, green); ALL user traffic goes to the LIVE one. The idle one is the
 * new version waiting to be tested, or the old version kept for instant rollback.
 *
 * - Switch = change the live colour (100 % at once, no mixed versions).
 * - Preview: a request with `x-deploy-color: <idle>` and the right
 *   `x-preview-token` reaches the IDLE colour, so the new version can be smoke
 *   tested in production before any user sees it.
 * - Observable: every response says which colour served it (x-served-by) and
 *   is counted per colour + status class.
 */
// Proxy handlers (http-proxy-middleware) return a Promise.
export type Handler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;
export type Color = 'blue' | 'green';

const requests = counter(
  'gateway_deploy_requests_total',
  'Requests by upstream, blue/green colour and status class',
  ['upstream', 'color', 'status_class'],
);

export function pickColor(
  req: Request,
  live: Color,
  hasGreen: boolean,
  previewToken: string | undefined,
): Color {
  const wanted = req.headers['x-deploy-color'];
  const idle: Color = live === 'blue' ? 'green' : 'blue';
  const canPreview =
    !!previewToken && req.headers['x-preview-token'] === previewToken;
  if (canPreview && wanted === idle && (idle === 'blue' || hasGreen)) {
    return idle;
  }
  return live === 'green' && !hasGreen ? 'blue' : live; // no green = blue only
}

export function blueGreen(
  upstream: string,
  routes: { blue: Handler; green?: Handler },
  live: Color,
  previewToken?: string,
): Handler {
  return (req, res, next) => {
    const color = pickColor(req, live, !!routes.green, previewToken);
    res.setHeader('x-served-by', color);
    res.on('finish', () =>
      requests.inc({
        upstream,
        color,
        status_class: `${Math.floor(res.statusCode / 100)}xx`,
      }),
    );
    const handler =
      color === 'green' && routes.green ? routes.green : routes.blue;
    return handler(req, res, next);
  };
}
