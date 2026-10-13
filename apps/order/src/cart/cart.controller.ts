import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { CartService } from './cart.service';
import { AddItemDto } from './dto/add-item.dto';
import { UpdateQtyDto } from './dto/update-qty.dto';

// The gateway already checked the token; checking again here means a request
// that bypasses the gateway still can't act as someone else. The user id
// comes only from the token, never from the URL or body.
@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(
    @CurrentUser() user: JwtPayload,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.getCart(user.sub, cid);
  }

  @Post('items')
  add(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddItemDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.addItem(user.sub, dto.productId, dto.qty, cid);
  }

  @Patch('items/:productId')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('productId') productId: string,
    @Body() dto: UpdateQtyDto,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.updateQty(user.sub, productId, dto.qty, cid);
  }

  @Delete('items/:productId')
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('productId') productId: string,
    @Headers('x-correlation-id') cid?: string,
  ) {
    return this.cart.removeItem(user.sub, productId, cid);
  }
}
