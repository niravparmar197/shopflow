import { counter } from '@app/observability';

// Business metrics. Labels stay small and FIXED (a status, a reason, an
// error code), never an order id: one series per order would explode
// Prometheus. Order ids belong in traces; numbers belong in metrics.

export const ordersPlaced = counter(
  'shopflow_orders_placed_total',
  'Orders created',
);

export const orderTransitions = counter(
  'shopflow_order_transitions_total',
  'Order status changes',
  ['to', 'reason'],
);

export const checkoutRejected = counter(
  'shopflow_checkout_rejected_total',
  'Checkouts refused, by error code',
  ['code'],
);

export const revenuePaise = counter(
  'shopflow_revenue_paise_total',
  'Value of paid orders',
);
