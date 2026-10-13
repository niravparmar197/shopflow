import { ConflictException } from '@nestjs/common';

export enum PaymentStatus {
  PENDING = 'PENDING', // waiting for the user; failed attempts may be retried
  SUCCEEDED = 'SUCCEEDED',
  EXPIRED = 'EXPIRED', // time ran out → payment.failed → order cancelled
  REFUND_PENDING = 'REFUND_PENDING', // late success: money taken, order already cancelled
  REFUNDED = 'REFUNDED', // the late success's money was returned
}

/*
 * The same idea as the order's State pattern, smaller: a transition table.
 *
 * PENDING ─succeed─► SUCCEEDED ─(order cancelled)─┐
 *    └────expire───► EXPIRED ─(late success)──────┴─► REFUND_PENDING ─(refund)─► REFUNDED
 */
const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.SUCCEEDED, PaymentStatus.EXPIRED],
  [PaymentStatus.EXPIRED]: [PaymentStatus.REFUND_PENDING],
  [PaymentStatus.REFUND_PENDING]: [PaymentStatus.REFUNDED],
  [PaymentStatus.SUCCEEDED]: [PaymentStatus.REFUND_PENDING],
  [PaymentStatus.REFUNDED]: [],
};

/** Throws a 409 INVALID_PAYMENT_TRANSITION if `from → to` isn't allowed. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!ALLOWED[from].includes(to)) {
    throw new ConflictException({
      code: 'INVALID_PAYMENT_TRANSITION',
      message: `Payment cannot go from ${from} to ${to}`,
    });
  }
}
