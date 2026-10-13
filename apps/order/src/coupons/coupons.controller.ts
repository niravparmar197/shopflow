import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { CouponsService } from './coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';

// Admin only: create and list coupons.
@Controller('coupons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Post()
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Get()
  list() {
    return this.coupons.list();
  }
}
