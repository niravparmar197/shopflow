import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsMongoId, IsUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { InternalTokenGuard } from '@app/common';
import { OrderStatus } from './order-status';

class PurchaseQuery {
  @IsUUID()
  userId!: string;

  @IsMongoId()
  productId!: string;
}

/**
 * Product → order only (Phase 2 P5): "did this user receive this product?"
 * Only buyers may review a product. The gateway never routes /v1/internal/*.
 */
@ApiExcludeController()
@Controller('internal/purchases')
@UseGuards(InternalTokenGuard)
export class InternalPurchasesController {
  constructor(private readonly ds: DataSource) {}

  @Get()
  async check(@Query() q: PurchaseQuery) {
    const rows = await this.ds.query<unknown[]>(
      `SELECT 1 FROM orders o
         JOIN order_items i ON i.order_id = o.id
        WHERE o.user_id = $1 AND i.product_id = $2 AND o.status = $3
        LIMIT 1`,
      [q.userId, q.productId, OrderStatus.DELIVERED],
    );
    return { delivered: rows.length > 0 };
  }
}
