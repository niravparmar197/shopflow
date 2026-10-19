import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ParseObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Types } from 'mongoose';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { ListReviewsQuery, WriteReviewDto } from './dto/review.dto';
import { ReviewsService } from './reviews.service';

/** Product reviews and ratings (Phase 2 P5). Reading is public. */
@ApiTags('Reviews')
@Controller('products/:productId/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Reviews, newest first; the first page also has the star summary */
  @Get()
  @ApiOkResponse({ description: 'items[], nextCursor, summary?' })
  @ApiError(404, 'NOT_FOUND (no such product)')
  list(
    @Param('productId', ParseObjectIdPipe) productId: Types.ObjectId,
    @Query() q: ListReviewsQuery,
  ) {
    return this.reviews.list(String(productId), q);
  }

  /** Your own review of this product */
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiError(404, 'REVIEW_NOT_FOUND')
  mine(
    @Param('productId', ParseObjectIdPipe) productId: Types.ObjectId,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.reviews.mine(String(productId), user.sub);
  }

  /** Write or edit your review (only after the product was delivered to you) */
  @Put()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiError(403, 'NOT_A_BUYER')
  @ApiError(404, 'NOT_FOUND (no such product)')
  @ApiError(503, 'PURCHASE_CHECK_UNAVAILABLE (order service down)')
  write(
    @Param('productId', ParseObjectIdPipe) productId: Types.ObjectId,
    @CurrentUser() user: JwtPayload,
    @Body() dto: WriteReviewDto,
  ) {
    return this.reviews.write(String(productId), user.sub, dto);
  }

  /** Delete your review */
  @Delete()
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiError(404, 'REVIEW_NOT_FOUND')
  async remove(
    @Param('productId', ParseObjectIdPipe) productId: Types.ObjectId,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.reviews.remove(String(productId), user.sub);
  }
}
