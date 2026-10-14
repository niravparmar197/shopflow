import { IsInt, IsMongoId, Max, Min } from 'class-validator';

export class StartSaleDto {
  @IsMongoId()
  productId!: string;

  /** Units on sale (taken from available stock) */
  @IsInt()
  @Min(1)
  quantity!: number;

  /** How long the sale runs, at most 24 h */
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes!: number;
}
