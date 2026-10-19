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
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiNoContentResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { FlashSaleService } from './flash-sale.service';
import { InternalTokenGuard } from './internal-token.guard';
import { StartSaleDto } from './start-sale.dto';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const assertProductId = (id: string) => {
  if (!OBJECT_ID.test(id)) {
    throw new NotFoundException({
      code: 'FLASH_SALE_NOT_FOUND',
      message: 'No flash sale for this product',
    });
  }
};

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
@ApiTags('Admin � Flash sales')
@ApiBearerAuth()
@Controller('inventory/flash-sales')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class FlashSaleAdminController {
  constructor(private readonly flash: FlashSaleService) {}

  /** Start a flash sale: moves the units from stock into the sale */
  @Post()
  @ApiError(400, 'NOT_ENOUGH_STOCK')
  @ApiError(409, 'SALE_ACTIVE (one sale per product at a time)')
  start(@Body() dto: StartSaleDto) {
    return this.flash.start(dto.productId, dto.quantity, dto.durationMinutes);
  }

  /** Units left, end time */
  @Get(':productId')
  @ApiError(404, 'FLASH_SALE_NOT_FOUND')
  status(@Param('productId') id: string) {
    assertProductId(id);
    return this.flash.status(id);
  }

  /** End the sale early; unsold units go back to stock */
  @Delete(':productId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Ended' })
  @ApiError(404, 'FLASH_SALE_NOT_FOUND')
  async end(@Param('productId') id: string) {
    assertProductId(id);
    await this.flash.end(id);
  }
}

/** Public, through the gateway: GET /v1/flash-sales (Phase 2 P5). */
@ApiTags('Flash sales')
@Controller('flash-sales')
export class FlashSalePublicController {
  constructor(private readonly flash: FlashSaleService) {}

  /** Sales running now: units left and seconds left, ending soonest first */
  @Get()
  async list() {
    return { items: await this.flash.activeSales() };
  }
}

/** Order → inventory only. The gateway must NEVER route /v1/internal/*. */
@ApiExcludeController()
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
