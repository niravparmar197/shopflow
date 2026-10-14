import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { CheckoutService } from './checkout.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { toOrderResponse } from './order.mapper';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * A double click or a retry must not create a second order: the client
   * sends the same Idempotency-Key each time and gets the first result back.
   */
  @Post()
  async place(
    @CurrentUser() user: JwtPayload,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() dto: PlaceOrderDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-correlation-id') cid?: string,
  ) {
    const key = this.idempotency.validateKey(rawKey);
    const claim = await this.idempotency.claim(
      user.sub,
      key,
      this.idempotency.hash(dto),
    );
    if (claim.kind === 'replay') {
      res.status(claim.status).setHeader('Idempotent-Replayed', 'true');
      return claim.body;
    }

    try {
      const order = await this.checkout.placeOrder(user.sub, dto, {
        cid,
        customerEmail: user.email,
        beforeCommit: (m, saved) =>
          this.idempotency.complete(
            m,
            user.sub,
            key,
            201,
            toOrderResponse(saved),
          ),
      });
      return toOrderResponse(order);
    } catch (err) {
      // Rolled back, so there is no order. Errors like PRICE_CHANGED depend
      // on the cart at that moment; free the key so a retry can succeed.
      await this.idempotency.release(user.sub, key).catch(() => undefined);
      throw err;
    }
  }

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.listMine(user.sub, limit, cursor);
  }

  /** From the read model; GET /orders/:id below stays on the write model. */
  @Get(':id/tracking')
  tracking(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.tracking(user.sub, id);
  }

  @Get(':id')
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toOrderResponse(await this.orders.findMine(user.sub, id));
  }
}
