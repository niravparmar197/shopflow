import { JwtService } from '@nestjs/jwt';
import {
  AccessTokenError,
  type AuthenticatedRequest,
  sendError,
  verifyAccessToken,
} from '@app/common';
import type { NextFunction, Response } from 'express';

// Rejects requests without a valid access token before they reach a service.
export function jwtMiddleware(jwt: JwtService) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      req.user = await verifyAccessToken(jwt, req.headers);
      next();
    } catch (err) {
      if (err instanceof AccessTokenError) {
        return sendError(req, res, 401, err.message);
      }
      next(err);
    }
  };
}
