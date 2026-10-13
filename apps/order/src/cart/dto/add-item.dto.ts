import { IsInt, IsMongoId, Max, Min } from 'class-validator';
import { MAX_QTY } from '../cart.repository';

export class AddItemDto {
  @IsMongoId()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  qty!: number;
}
