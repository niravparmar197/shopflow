import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { InvoicesService } from '../invoices/invoices.service';
import { sendInvoice } from '../invoices/send-pdf';
import { AdminOrdersQuery } from './dto/admin-orders.query';
import { ShipOrderDto } from './dto/ship-order.dto';
import { OrderActionsService } from './order-actions.service';
import { toAdminOrderResponse } from './order.mapper';
import { OrdersService } from './orders.service';

// Admin only: every customer's orders (the admin web app's Orders page).
@ApiTags('Admin – Orders')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@ApiError(403, 'FORBIDDEN (admins only)')
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly actions: OrderActionsService,
    private readonly invoices: InvoicesService,
  ) {}

  /** All orders, newest first; optional status filter, cursor paging */
  @Get()
  @ApiOkResponse({
    description:
      'items[] (id, userId, customerEmail, status, paymentStatus, title, itemCount, totalPaise, createdAt) + nextCursor',
  })
  @ApiError(
    400,
    'INVALID_CURSOR | BAD_REQUEST (unknown status, limit not 1–50)',
  )
  list(@Query() q: AdminOrdersQuery) {
    return this.orders.listAll(q.limit ?? 20, q.cursor, q.status);
  }

  /** One order with its items and the customer */
  @Get(':id')
  @ApiError(404, 'ORDER_NOT_FOUND')
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    return toAdminOrderResponse(await this.orders.findAny(id));
  }

  /** The order's GST invoice as a PDF */
  @Get(':id/invoice')
  @ApiProduces('application/pdf')
  @ApiError(404, 'ORDER_NOT_FOUND')
  @ApiError(409, 'INVOICE_NOT_READY (not paid yet)')
  async invoice(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendInvoice(res, await this.invoices.pdf(id));
  }

  /** Hand a PAID order to the courier (optional carrier + tracking number) */
  @Post(':id/ship')
  @HttpCode(200)
  @ApiError(404, 'ORDER_NOT_FOUND')
  @ApiError(409, 'INVALID_ORDER_TRANSITION (only a PAID order can ship)')
  async ship(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipOrderDto,
  ) {
    return toAdminOrderResponse(await this.actions.ship(id, dto));
  }

  /** Mark a SHIPPED order as delivered */
  @Post(':id/deliver')
  @HttpCode(200)
  @ApiError(404, 'ORDER_NOT_FOUND')
  @ApiError(409, 'INVALID_ORDER_TRANSITION (only a SHIPPED order)')
  async deliver(@Param('id', ParseUUIDPipe) id: string) {
    return toAdminOrderResponse(await this.actions.deliver(id));
  }

  /** Cancel any order before it ships (a paid one is refunded) */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiError(404, 'ORDER_NOT_FOUND')
  @ApiError(
    409,
    'INVALID_ORDER_TRANSITION (already shipped, delivered, cancelled or failed)',
  )
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return toAdminOrderResponse(
      await this.actions.cancel(id, 'ADMIN_CANCELLED'),
    );
  }
}
