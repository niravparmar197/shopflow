import { IsInt, Max, Min } from 'class-validator';
import { MAX_QTY } from '../cart.repository';

export class UpdateQtyDto {
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  qty!: number;
}
