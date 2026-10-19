import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class WriteReviewDto {
  /** 1 to 5 stars */
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 80)
  title?: string;

  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  body!: string;

  /** The name shown with the review (your profile name) */
  @Transform(trim)
  @IsString()
  @Length(2, 40)
  authorName!: string;
}

export class ListReviewsQuery {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;
}
