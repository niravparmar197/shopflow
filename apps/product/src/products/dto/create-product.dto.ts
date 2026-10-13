import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsString()
  @Length(2, 120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must look like "my-product-1"',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string;

  @IsString()
  @Length(2, 50)
  category!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  pricePaise!: number;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}
