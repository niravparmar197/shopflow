import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsMongoId, IsUUID, Max, Min } from 'class-validator';
import { JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { FlashSaleService } from './flash-sale.service';
import { InternalTokenGuard } from './internal-token.guard';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const assertProductId = (id: string) => {
  if (!OBJECT_ID.test(id)) {
    throw new NotFoundException({
      code: 'FLASH_SALE_NOT_FOUND',
      message: 'No flash sale for this product',
    });
  }
};

class StartSaleDto {
  @IsMongoId()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes!: number;
}

class TokenDto {
  @IsMongoId()
  productId!: string;

  @IsUUID()
  userId!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

/** Admin, through the gateway: /v1/inventory/flash-sales. */
@Controller('inventory/flash-sales')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class FlashSaleAdminController {
  constructor(private readonly flash: FlashSaleService) {}

  @Post()
  start(@Body() dto: StartSaleDto) {
    return this.flash.start(dto.productId, dto.quantity, dto.durationMinutes);
  }

  @Get(':productId')
  status(@Param('productId') id: string) {
    assertProductId(id);
    return this.flash.status(id);
  }

  @Delete(':productId')
  @HttpCode(204)
  async end(@Param('productId') id: string) {
    assertProductId(id);
    await this.flash.end(id);
  }
}

/** Order → inventory only. The gateway must NEVER route /v1/internal/*. */
@Controller('internal/flash-sales')
@UseGuards(InternalTokenGuard)
export class FlashSaleInternalController {
  constructor(private readonly flash: FlashSaleService) {}

  @Get('active')
  async active() {
    return { productIds: await this.flash.activeProductIds() };
  }

  @Post('acquire')
  @HttpCode(200)
  acquire(@Body() dto: TokenDto) {
    return this.flash.acquire(dto.productId, dto.userId, dto.quantity);
  }

  @Post('release')
  @HttpCode(204)
  async release(@Body() dto: TokenDto) {
    await this.flash.release(dto.productId, dto.userId, dto.quantity);
  }
}
