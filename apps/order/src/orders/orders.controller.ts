import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { InvoicesService } from '../invoices/invoices.service';
import { sendInvoice } from '../invoices/send-pdf';
import { OrderActionsService } from './order-actions.service';
import { CheckoutService } from './checkout.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { toOrderResponse } from './order.mapper';
import { OrdersService } from './orders.service';

@ApiTags('Orders')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
    private readonly actions: OrderActionsService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Place an order from your cart.
   *
   * A double click or a retry must not create a second order: the client
   * sends the same Idempotency-Key each time and gets the first result back.
   */
  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8–100 chars (letters, digits, - _). Send the SAME key when you retry, so you never get 2 orders. A replay answers with the header Idempotent-Replayed: true.',
  })
  @ApiCreatedResponse({
    description:
      'Order created with status PENDING. Stock is reserved in the background.',
  })
  @ApiError(
    400,
    'IDEMPOTENCY_KEY_REQUIRED | IDEMPOTENCY_KEY_INVALID | BAD_REQUEST (validation)',
  )
  @ApiError(
    409,
    'PRICE_CHANGED | CART_ITEM_UNAVAILABLE | COUPON_NOT_APPLICABLE | COUPON_EXHAUSTED | SOLD_OUT | ALREADY_BOUGHT_IN_SALE | CHECKOUT_IN_PROGRESS | IDEMPOTENCY_IN_PROGRESS',
  )
  @ApiError(422, 'CART_EMPTY | IDEMPOTENCY_KEY_REUSED | FLASH_LIMIT')
  @ApiError(
    429,
    'RATE_LIMITED (per user, at the gateway) | SERVER_BUSY (flash sale); see the Retry-After header',
  )
  @ApiError(
    503,
    'SERVICE_UNAVAILABLE (product catalog down; nothing was saved, safe to retry)',
  )
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

  /** My orders, newest first (from the read model) */
  @Get()
  @ApiOkResponse({
    description:
      'items[] + nextCursor. Orders from the last few seconds may have syncing: true.',
  })
  @ApiError(400, 'INVALID_CURSOR')
  list(
    @CurrentUser() user: JwtPayload,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.listMine(user.sub, limit, cursor);
  }

  /**
   * Status timeline of one order.
   *
   * From the read model; GET /orders/:id below stays on the write model.
   */
  @Get(':id/tracking')
  @ApiError(404, "ORDER_NOT_FOUND (also for other users' orders)")
  tracking(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.tracking(user.sub, id);
  }

  /**
   * Cancel your order (before it ships).
   *
   * PENDING / CONFIRMED / PAID → CANCELLED (reason USER_CANCELLED). The saga
   * does the rest: the stock goes back on sale and a paid order is refunded.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ description: 'The order, now CANCELLED' })
  @ApiError(404, "ORDER_NOT_FOUND (also for other users' orders)")
  @ApiError(
    409,
    'INVALID_ORDER_TRANSITION (already shipped, delivered, cancelled or failed)',
  )
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toOrderResponse(
      await this.actions.cancel(id, 'USER_CANCELLED', user.sub),
    );
  }

  /** One order with its items (the write model: always current) */
  @Get(':id')
  @ApiError(404, "ORDER_NOT_FOUND (also for other users' orders)")
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toOrderResponse(await this.orders.findMine(user.sub, id));
  }

  /** GST tax invoice as a PDF (paid orders only) */
  @Get(':id/invoice')
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'invoice-SF-26-27-000001.pdf' })
  @ApiError(404, "ORDER_NOT_FOUND (also for other users' orders)")
  @ApiError(409, 'INVOICE_NOT_READY (not paid yet)')
  async invoice(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    sendInvoice(res, await this.invoices.pdf(id, user.sub));
  }
}
