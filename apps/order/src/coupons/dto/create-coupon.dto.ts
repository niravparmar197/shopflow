import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { CouponType } from '../coupon.entity';

export const COUPON_CODE = /^[A-Za-z0-9]{4,20}$/;

// Rules that compare fields (percent ≤ 90, validTo after validFrom) are
// checked in CouponsService.create.
export class CreateCouponDto {
  @Matches(COUPON_CODE, { message: 'code must be 4-20 letters or digits' })
  code!: string;

  @IsEnum(CouponType)
  type!: CouponType;

  @IsInt()
  @Min(1)
  value!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscountPaise?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minCartPaise?: number;

  // Products store categories lowercased, so match that.
  @IsOptional()
  @IsString()
  @Length(2, 50)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  category?: string;

  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  @Type(() => Date)
  @IsDate()
  validFrom!: Date;

  @Type(() => Date)
  @IsDate()
  validTo!: Date;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;
}
