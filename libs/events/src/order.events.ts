import { z } from 'zod';

export const OrderEvents = {
  CREATED: 'order.created',
  CONFIRMED: 'order.confirmed',
  CANCELLED: 'order.cancelled',
} as const;

const OrderItem = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});

export const OrderCreatedV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  items: z.array(OrderItem).min(1),
  totalPaise: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type OrderCreatedV1 = z.infer<typeof OrderCreatedV1Schema>;
