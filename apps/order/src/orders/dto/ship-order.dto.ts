import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** POST /v1/admin/orders/:id/ship */
export class ShipOrderDto {
  /** e.g. Delhivery, Blue Dart, India Post */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  carrier?: string;

  /** The courier's tracking number (AWB) */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  trackingNumber?: string;
}
