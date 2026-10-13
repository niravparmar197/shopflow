import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export const JWT_ISSUER = 'shopflow';
export const JWT_AUDIENCE = 'shopflow-api';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: string;
}

export type AuthenticatedRequest = Request & { user: JwtPayload };

// Checks the Bearer access token. Only needs the public key, so any
// service can use it; only the user service can sign tokens.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing access token');
    }
    try {
      req.user = await this.jwt.verifyAsync<JwtPayload>(token, {
        algorithms: ['RS256'], // never accept other algorithms (e.g. "none", HS256)
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
