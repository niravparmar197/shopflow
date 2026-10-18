import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrderStatus } from '../order-status';

/** GET /v1/admin/orders?status&limit&cursor */
export class AdminOrdersQuery {
  /** Only orders with this status */
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  /** Page size, 1–50 (default 20) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** nextCursor from the previous page */
  @IsOptional()
  @IsString()
  cursor?: string;
}
