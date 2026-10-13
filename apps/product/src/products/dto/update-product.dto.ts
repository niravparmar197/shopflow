import { PartialType } from '@nestjs/mapped-types';
import { IsInt, Min } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

export class UpdateProductDto extends PartialType(CreateProductDto) {
  // The version the client last read. If it changed since, the update is
  // rejected instead of silently overwriting someone else's edit.
  @IsInt()
  @Min(0)
  version!: number;
}
