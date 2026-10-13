import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './jwt-auth.guard';
import { ROLES_KEY } from './roles.decorator';

// Runs after JwtAuthGuard, which puts the token payload on req.user.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles?.length) return true;

    const { user } = ctx
      .switchToHttp()
      .getRequest<Partial<AuthenticatedRequest>>();
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission');
    }
    return true;
  }
}
