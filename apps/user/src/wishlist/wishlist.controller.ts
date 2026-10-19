import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { WishlistService } from './wishlist.service';

class ProductParam {
  @IsMongoId()
  productId!: string;
}

// The caller's own wishlist (Phase 2 P5); the user id comes from the token.
@ApiTags('Wishlist')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('users/me/wishlist')
@UseGuards(JwtAuthGuard)
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  /** Saved product ids, newest first */
  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    const items = await this.wishlist.list(user.sub);
    return {
      items: items.map((i) => ({
        productId: i.productId,
        createdAt: i.createdAt,
      })),
    };
  }

  /** Save a product (saving it twice is fine) */
  @Put(':productId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Saved' })
  @ApiError(400, 'BAD_REQUEST (not a product id)')
  @ApiError(409, 'WISHLIST_FULL (100 products)')
  async add(@CurrentUser() user: JwtPayload, @Param() p: ProductParam) {
    await this.wishlist.add(user.sub, p.productId);
  }

  /** Remove a product */
  @Delete(':productId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removed' })
  async remove(@CurrentUser() user: JwtPayload, @Param() p: ProductParam) {
    await this.wishlist.remove(user.sub, p.productId);
  }
}
