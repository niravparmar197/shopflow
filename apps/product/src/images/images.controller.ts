import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { ConfirmImageDto } from './dto/confirm-image.dto';
import { UploadUrlDto } from './dto/upload-url.dto';
import { ImagesService } from './images.service';

@ApiTags('Admin – Products')
@ApiBearerAuth()
@ApiError(403, 'FORBIDDEN (admins only)')
@Controller('products/:id/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  /** Step 1: a presigned POST to upload the file straight to S3 */
  @Post('upload-url')
  @HttpCode(200)
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

  /** Step 2: after the upload, check the file and attach it to the product */
  @Post('confirm')
  @HttpCode(200)
  @ApiError(
    400,
    'BAD_REQUEST (upload not found or expired, wrong key, or not a valid image)',
  )
  confirm(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: ConfirmImageDto,
  ) {
    return this.images.confirm(id.toHexString(), dto.key);
  }
}
