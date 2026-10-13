import { z } from 'zod';

export const PaymentEvents = {
  SUCCEEDED: 'payment.succeeded', // Order → PAID, Inventory commits the stock (Part 4)
  FAILED: 'payment.failed', // final: expired without a success
  REFUNDED: 'payment.refunded', // success after expiry → money returned
} as const;

export const PaymentSucceededV1Schema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  userId: z.uuid(),
  amountPaise: z.number().int().nonnegative(),
  provider: z.string().min(1), // 'none' for a free order
});
export type PaymentSucceededV1 = z.infer<typeof PaymentSucceededV1Schema>;

export const PaymentFailedV1Schema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  userId: z.uuid(),
  reason: z.string().min(1),
});
export type PaymentFailedV1 = z.infer<typeof PaymentFailedV1Schema>;
