import { Logger } from '@nestjs/common';
import { type AuthenticatedRequest, sendError } from '@app/common';
import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const logger = new Logger('Proxy');
const TIMEOUT_MS = 5000;

// Identity headers that only the gateway may set, after checking the JWT.
const IDENTITY_HEADERS = ['x-user-id', 'x-user-role'];

export function proxyTo(target: string) {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    xfwd: true, // tell the service the real client IP
    proxyTimeout: TIMEOUT_MS, // max wait for the service to respond
    timeout: TIMEOUT_MS,
    // Nest mounts middleware on a path, which strips it from req.url.
    // Forward the full original path instead.
    pathRewrite: (_path, req) => req.originalUrl,
    on: {
      proxyReq: (proxyReq, req) => {
        // Never trust identity headers from the client.
        IDENTITY_HEADERS.forEach((h) => proxyReq.removeHeader(h));

        const { user } = req as Partial<AuthenticatedRequest>;
        if (user) {
          proxyReq.setHeader('x-user-id', user.sub);
          proxyReq.setHeader('x-user-role', user.role);
        }
      },
      error: (err: NodeJS.ErrnoException, req, res) => {
        const timedOut = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        logger.warn({ err, target }, 'Proxy request failed');
        // `res` is a socket only for WebSocket upgrades, which we don't proxy.
        if ('status' in res) {
          sendError(
            req,
            res,
            timedOut ? 504 : 502,
            timedOut ? 'Service timed out' : 'Service unavailable',
          );
        }
      },
    },
  });
}
