import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { CheckoutService } from './checkout.service';
import { PaymentsService } from './payments.service';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly checkoutSvc: CheckoutService,
  ) {}

  /** The payment for one of your orders. */
  @Get(':orderId')
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
  checkout(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.checkoutSvc.checkout(user.sub, orderId);
  }
}
