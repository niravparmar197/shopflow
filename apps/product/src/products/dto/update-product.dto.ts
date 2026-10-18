import { PartialType } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

// PartialType from @nestjs/swagger (not @nestjs/mapped-types): same validation,
// and the docs show every optional field instead of only `version`.
export class UpdateProductDto extends PartialType(CreateProductDto) {
  // The version the client last read. If it changed since, the update is
  // rejected instead of silently overwriting someone else's edit.
  @IsInt()
  @Min(0)
  version!: number;
}
