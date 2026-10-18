import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import {
  ApiBearerAuth,
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
import {
  ProductResponseDto,
  toProductResponse,
} from '../products/dto/product-response.dto';
import { ConfirmImageDto } from './dto/confirm-image.dto';
import { UploadUrlDto } from './dto/upload-url.dto';
import { UploadUrlResponseDto } from './dto/upload-url-response.dto';
import { ImagesService } from './images.service';

@ApiTags('Admin – Products')
@ApiBearerAuth()
@ApiParam({
  name: 'id',
  type: String,
  description: 'Product id (MongoDB ObjectId)',
})
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@ApiError(403, 'FORBIDDEN (admins only)')
@Controller('products/:id/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ImagesController {
  private readonly assetBase: string;

  constructor(
    private readonly images: ImagesService,
    config: ConfigService<Env, true>,
  ) {
    this.assetBase = config
      .getOrThrow('ASSET_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  @Post('upload-url')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Step 1: get a presigned POST to upload the file straight to S3',
    description:
      'POST the file to `url` as multipart/form-data: first every entry of `fields`, then the file as `file`. Then call /confirm with `key`.',
  })
  @ApiOkResponse({ type: UploadUrlResponseDto })
  @ApiError(
    400,
    'BAD_REQUEST (validation, or the product has the maximum number of images)',
  )
  uploadUrl(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UploadUrlDto,
  ) {
    return this.images.createUploadUrl(id.toHexString(), dto);
  }

  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Step 2: check the uploaded file and attach it to the product',
  })
  @ApiOkResponse({
    type: ProductResponseDto,
    description: 'The product with the new image',
  })
  @ApiError(
    400,
    'BAD_REQUEST (upload not found or expired, wrong key, or not a valid image)',
  )
  @ApiError(404, 'NOT_FOUND (no such product)')
  async confirm(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: ConfirmImageDto,
  ): Promise<ProductResponseDto> {
    const product = await this.images.confirm(id.toHexString(), dto.key);
    return toProductResponse(product, this.assetBase);
  }
}
