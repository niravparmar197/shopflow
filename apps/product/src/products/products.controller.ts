import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  type Env,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '@app/common';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import {
  ProductResponseDto,
  toProductResponse,
} from './dto/product-response.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('Admin – Products')
@Controller('products')
export class ProductsController {
  private readonly assetBase: string;

  constructor(
    private readonly products: ProductsService,
    config: ConfigService<Env, true>,
  ) {
    this.assetBase = config
      .getOrThrow('ASSET_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  // Public. Through the gateway these are served over gRPC and documented in
  // the gateway's spec, so they are hidden here.

  @Get()
  @ApiExcludeEndpoint()
  list(@Query() q: ListProductsQuery) {
    return this.products.list(q);
  }

  @Get(':idOrSlug')
  @ApiExcludeEndpoint()
  findOne(@Param('idOrSlug') idOrSlug: string) {
    return this.products.findOne(idOrSlug);
  }

  // Admin only. Responses use the same product shape as the public API.

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product' })
  @ApiCreatedResponse({ type: ProductResponseDto })
  @ApiError(
    400,
    'BAD_REQUEST (validation: name 2-200, slug a-z 0-9 and "-", category, pricePaise ≥ 0)',
  )
  @ApiError(401, 'UNAUTHORIZED (missing or expired token)')
  @ApiError(403, 'FORBIDDEN (admins only)')
  @ApiError(409, 'CONFLICT (slug already exists)')
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    return toProductResponse(await this.products.create(dto), this.assetBase);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Send only the fields to change, plus the `version` you last read. If someone changed the product since, you get 409: reload and retry.',
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Product id (MongoDB ObjectId)',
  })
  @ApiOkResponse({ type: ProductResponseDto })
  @ApiError(400, 'BAD_REQUEST (validation, or id is not a valid ObjectId)')
  @ApiError(401, 'UNAUTHORIZED (missing or expired token)')
  @ApiError(403, 'FORBIDDEN (admins only)')
  @ApiError(404, 'NOT_FOUND')
  @ApiError(
    409,
    'CONFLICT (changed by someone else: reload and retry; or slug taken)',
  )
  async update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseDto> {
    return toProductResponse(
      await this.products.update(id, dto),
      this.assetBase,
    );
  }
}
