export enum OrderStatus {
  PENDING = 'PENDING', // created, waiting for stock + payment
  CONFIRMED = 'CONFIRMED', // stock reserved (F5)
  PAID = 'PAID', // payment done (F6)
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export type OrderAction =
  'confirm' | 'pay' | 'ship' | 'deliver' | 'cancel' | 'fail';
