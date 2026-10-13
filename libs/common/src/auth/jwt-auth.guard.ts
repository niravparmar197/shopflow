import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { IncomingHttpHeaders } from 'node:http';
import { Request } from 'express';

export const JWT_ISSUER = 'shopflow';
export const JWT_AUDIENCE = 'shopflow-api';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: string;
}

export type AuthenticatedRequest = Request & { user: JwtPayload };

export class AccessTokenError extends Error {}

/**
 * Checks the Bearer access token in the headers and returns its payload.
 * Only needs the public key, so any service (and the gateway) can use it.
 */
export async function verifyAccessToken(
  jwt: JwtService,
  headers: IncomingHttpHeaders,
): Promise<JwtPayload> {
  const [type, token] = (headers.authorization ?? '').split(' ');
  if (type !== 'Bearer' || !token) {
    throw new AccessTokenError('Missing access token');
  }
  try {
    return await jwt.verifyAsync<JwtPayload>(token, {
      algorithms: ['RS256'], // never accept other algorithms (e.g. "none", HS256)
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    throw new AccessTokenError('Invalid or expired access token');
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    try {
      req.user = await verifyAccessToken(this.jwt, req.headers);
      return true;
    } catch (err) {
      if (err instanceof AccessTokenError) {
        throw new UnauthorizedException(err.message);
      }
      throw err;
    }
  }
}
