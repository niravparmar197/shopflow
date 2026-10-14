import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { CartService } from './cart.service';
import { AddItemDto } from './dto/add-item.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { UpdateQtyDto } from './dto/update-qty.dto';

// The gateway already checked the token; checking again here means a request
// that bypasses the gateway still can't act as someone else. The user id
// comes only from the token, never from the URL or body.
@ApiTags('Cart')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  /** Your cart, priced now (prices and availability from the catalog) */
  @Get()
  get(
    @CurrentUser() user: JwtPayload,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.getCart(user.sub, cid);
  }

  /** Add a product; adding one that is already there increases its qty */
  @Post('items')
  @ApiError(400, 'BAD_REQUEST (validation, or the cart is full)')
  @ApiError(404, 'NOT_FOUND (no such product)')
  @ApiError(429, 'RATE_LIMITED (per user, at the gateway)')
  @ApiError(503, 'SERVICE_UNAVAILABLE (product catalog down)')
  add(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddItemDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.addItem(user.sub, dto.productId, dto.qty, cid);
  }

  /** Set the quantity of one product */
  @Patch('items/:productId')
  @ApiError(404, 'NOT_FOUND (item not in cart)')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('productId') productId: string,
    @Body() dto: UpdateQtyDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.updateQty(user.sub, productId, dto.qty, cid);
  }

  /** Remove one product */
  @Delete('items/:productId')
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('productId') productId: string,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.removeItem(user.sub, productId, cid);
  }

  /** Apply a coupon code (one per cart) */
  @Post('coupon')
  @HttpCode(200)
  @ApiError(
    400,
    'BAD_REQUEST (coupon not valid for this cart; message says why)',
  )
  @ApiError(404, 'NOT_FOUND (no such coupon)')
  @ApiError(409, 'COUPON_NOT_APPLICABLE | COUPON_EXHAUSTED')
  @ApiError(503, 'SERVICE_UNAVAILABLE (cannot price the cart right now)')
  applyCoupon(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApplyCouponDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.applyCoupon(user.sub, dto.code, cid);
  }

  /** Remove the coupon */
  @Delete('coupon')
  removeCoupon(
    @CurrentUser() user: JwtPayload,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.removeCoupon(user.sub, cid);
  }
}
