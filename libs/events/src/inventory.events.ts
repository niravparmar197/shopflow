import { z } from 'zod';

export const InventoryEvents = {
  RESERVED: 'stock.reserved',
  FAILED: 'stock.failed',
  RELEASED: 'stock.released', // F6 / F8
} as const;

export const StockReservedV1Schema = z.object({
  orderId: z.uuid(),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
});
export type StockReservedV1 = z.infer<typeof StockReservedV1Schema>;

export const StockFailedV1Schema = z.object({
  orderId: z.uuid(),
  reason: z.enum(['OUT_OF_STOCK']),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      requested: z.number().int(),
      available: z.number().int(),
    }),
  ),
});
export type StockFailedV1 = z.infer<typeof StockFailedV1Schema>;

// An audit event: why stock went back on sale. No consumer yet (F10 makes
// it a metric). ORDER_CANCELLED is for the normal path, later.
export const StockReleasedV1Schema = z.object({
  orderId: z.uuid(),
  reason: z.enum(['ORDER_CANCELLED', 'HOLD_EXPIRED']),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
});
export type StockReleasedV1 = z.infer<typeof StockReleasedV1Schema>;
