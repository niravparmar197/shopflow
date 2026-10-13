export const OrderEvents = {
  CREATED: 'order.created',
  CONFIRMED: 'order.confirmed',
  CANCELLED: 'order.cancelled',
} as const;

export interface OrderCreatedV1 {
  orderId: string;
  userId: string;
  items: { productId: string; quantity: number }[];
  totalPaise: number;
  currency: string;
}
