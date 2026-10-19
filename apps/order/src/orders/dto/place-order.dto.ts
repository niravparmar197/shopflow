import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min, ValidateNested } from 'class-validator';
import { ShippingAddressDto } from './shipping-address.dto';

export class PlaceOrderDto {
  /**
   * The total shown to the user; checkout fails with PRICE_CHANGED if the
   * real total differs.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalPaise?: number;

  /**
   * Where to deliver (Phase 2). Saved on the order as a copy. Optional in the
   * API so older clients keep working; the web app always sends it.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress?: ShippingAddressDto;
}
