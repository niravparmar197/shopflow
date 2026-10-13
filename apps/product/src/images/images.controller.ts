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
import { JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { ConfirmImageDto } from './dto/confirm-image.dto';
import { UploadUrlDto } from './dto/upload-url.dto';
import { ImagesService } from './images.service';

@Controller('products/:id/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('upload-url')
  @HttpCode(200)
  uploadUrl(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: UploadUrlDto,
  ) {
    return this.images.createUploadUrl(id.toHexString(), dto);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() dto: ConfirmImageDto,
  ) {
    return this.images.confirm(id.toHexString(), dto.key);
  }
}
