import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { CheckoutService } from './checkout.service';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly checkoutSvc: CheckoutService,
  ) {}

  /** The payment for one of your orders. */
  @Get(':orderId')
  @ApiError(404, "PAYMENT_NOT_FOUND (none yet, or another user's order)")
  get(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.payments.findMine(user.sub, orderId);
  }

  /**
   * Start paying: returns what the frontend needs to open the provider's
   * checkout. Safe to call again (refresh, back button): same provider order.
   */
  @Post(':orderId/checkout')
  @HttpCode(200)
  @ApiError(404, 'PAYMENT_NOT_FOUND')
  @ApiError(
    409,
    'PAYMENT_NOT_PAYABLE (already paid, failed, ...) | PAYMENT_EXPIRED',
  )
  @ApiError(429, 'RATE_LIMITED (per user, at the gateway)')
  @ApiError(502, 'PAYMENT_PROVIDER_ERROR (the provider rejected the request)')
  @ApiError(
    503,
    'PAYMENT_PROVIDER_UNAVAILABLE (provider down or circuit open; safe to retry) | PAYMENT_NOT_FOUND_YET (order just placed; retry in a moment)',
  )
  checkout(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.checkoutSvc.checkout(user.sub, orderId);
  }
}
