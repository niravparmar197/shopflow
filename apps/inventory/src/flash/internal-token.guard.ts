import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '@app/common';

/**
 * Service-to-service auth, simple version: a shared secret in a header,
 * compared in constant time. The gateway never routes /v1/internal/*, so
 * this is the second wall. Production: private network + mTLS (F11).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.expected = Buffer.from(
      config.get('INTERNAL_API_TOKEN', { infer: true }) ?? '',
    );
  }

  canActivate(ctx: ExecutionContext): boolean {
    const got = Buffer.from(
      String(
        ctx.switchToHttp().getRequest<Request>().headers['x-internal-token'] ??
          '',
      ),
    );
    // No token configured → closed, not open.
    if (
      this.expected.length === 0 ||
      got.length !== this.expected.length ||
      !timingSafeEqual(got, this.expected)
    ) {
      throw new UnauthorizedException({
        code: 'INTERNAL_ONLY',
        message: 'Internal endpoint',
      });
    }
    return true;
  }
}
