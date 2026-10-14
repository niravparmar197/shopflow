import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiError, JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { CouponsService } from './coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';

// Admin only: create and list coupons.
@ApiTags('Admin – Coupons')
@ApiBearerAuth()
@ApiError(403, 'FORBIDDEN (admins only)')
@Controller('coupons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  /** Create a coupon */
  @Post()
  @ApiError(400, 'BAD_REQUEST (validation, e.g. validTo before validFrom)')
  @ApiError(409, 'CONFLICT (code already exists)')
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  /** All coupons */
  @Get()
  list() {
    return this.coupons.list();
  }
}
