import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export const SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type ProductSort = (typeof SORTS)[number];

export class ListProductsQuery {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string; // search text

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** Order of the list (Phase 2 P5). Default: newest first. */
  @IsOptional()
  @IsIn(SORTS)
  sort?: ProductSort;

  // Capped so nobody can ask for the whole catalog in one request.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
