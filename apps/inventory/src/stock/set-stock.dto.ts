import { IsInt, Max, Min } from 'class-validator';

export class SetStockDto {
  /** Units that can be sold now; reserved holds are left as they are */
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  available!: number;
}
