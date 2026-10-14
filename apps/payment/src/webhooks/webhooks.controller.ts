import {
  BadRequestException,
  Controller,
  HttpCode,
  Param,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { WebhookService } from './webhook.service';

/**
 * Called by the payment provider, not a user: NO JWT. The HMAC signature
 * over the raw body is the authentication.
 */
// Hidden from the docs: providers call it with a signature; "Try it out" makes no sense.
@ApiExcludeController()
@Controller('payments/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException({
        code: 'NO_RAW_BODY',
        message: 'Raw body missing',
      });
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k,
        Array.isArray(v) ? v[0] : v,
      ]),
    );
    return this.webhooks.handle(provider, req.rawBody, headers);
  }
}
