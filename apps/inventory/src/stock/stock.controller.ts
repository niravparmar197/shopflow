import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { SetStockDto } from './set-stock.dto';
import { Stock } from './stock.entity';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Admin only: set and read stock levels.
@ApiTags('Admin � Stock')
@ApiBearerAuth()
@Controller('inventory/stock')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class StockController {
  constructor(
    @InjectRepository(Stock) private readonly stock: Repository<Stock>,
  ) {}

  /** Sets what can be sold now; reserved holds are left as they are. */
  @Put(':productId')
  async set(@Param('productId') productId: string, @Body() dto: SetStockDto) {
    assertProductId(productId);
    await this.stock.query(
      `INSERT INTO stock (product_id, available, version) VALUES ($1, $2, 1)
       ON CONFLICT (product_id) DO UPDATE
         SET available = EXCLUDED.available,
             version = stock.version + 1,
             updated_at = now()`,
      [productId, dto.available],
    );
    return this.get(productId);
  }

  /** Available and reserved units */
  @Get(':productId')
  @ApiError(404, 'STOCK_NOT_FOUND')
  async get(@Param('productId') productId: string) {
    assertProductId(productId);
    const row = await this.stock.findOneBy({ productId });
    if (!row) {
      throw new NotFoundException({
        code: 'STOCK_NOT_FOUND',
        message: 'No stock for this product',
      });
    }
    return {
      productId: row.productId,
      available: row.available,
      reserved: row.reserved,
    };
  }
}

function assertProductId(id: string) {
  if (!OBJECT_ID.test(id)) {
    throw new NotFoundException({
      code: 'STOCK_NOT_FOUND',
      message: 'No stock for this product',
    });
  }
}
