import { IsInt, IsOptional, Min } from 'class-validator';

export class PlaceOrderDto {
  // The total shown to the user; checkout fails with PRICE_CHANGED if the
  // real total differs.
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalPaise?: number;
}
