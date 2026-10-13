import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { CheckoutService } from './checkout.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { toOrderResponse } from './order.mapper';

// Part 3 adds the Idempotency-Key and the GET routes.
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  async place(
    @CurrentUser() user: JwtPayload,
    @Body() dto: PlaceOrderDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return toOrderResponse(await this.checkout.placeOrder(user.sub, dto, cid));
  }
}
