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
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('Admin – Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

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

  // Admin only

  /** Create a product */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiError(403, 'FORBIDDEN (admins only)')
  @ApiError(409, 'CONFLICT (slug already exists)')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  /** Update a product */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiError(403, 'FORBIDDEN (admins only)')
  @ApiError(404, 'NOT_FOUND')
  @ApiError(
    409,
    'CONFLICT (changed by someone else: reload and retry; or slug taken)',
  )
  update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(id, dto);
  }
}
