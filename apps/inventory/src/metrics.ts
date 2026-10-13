import { counter } from '@app/observability';

// Business metrics. Labels from fixed sets only (never an order id).

export const reservations = counter(
  'shopflow_reservations_total',
  'Stock reservations by result',
  ['result'], // reserved | out_of_stock
);

export const holdsReleased = counter(
  'shopflow_holds_released_total',
  'Reserved units given back to sale',
  ['reason'], // order_cancelled | hold_expired
);

/** The F8 invariant alarm: should stay 0 forever. */
export const paidWithoutReservation = counter(
  'shopflow_paid_without_reservation_total',
  'Orders PAID with no reservation left',
);

export const flashGate = counter(
  'shopflow_flash_gate_total',
  'Flash-sale gate answers',
  ['result'], // OK | SOLD_OUT | ALREADY_BOUGHT | LIMIT | NOT_FLASH
);
