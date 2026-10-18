import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { AdminOrdersQuery } from './dto/admin-orders.query';
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
  constructor(private readonly orders: OrdersService) {}

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
}
