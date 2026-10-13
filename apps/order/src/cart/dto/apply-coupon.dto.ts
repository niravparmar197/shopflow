import { Matches } from 'class-validator';
import { COUPON_CODE } from '../../coupons/dto/create-coupon.dto';

export class ApplyCouponDto {
  @Matches(COUPON_CODE, { message: 'code must be 4-20 letters or digits' })
  code!: string;
}
