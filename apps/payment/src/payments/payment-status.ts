import { ConflictException } from '@nestjs/common';

export enum PaymentStatus {
  PENDING = 'PENDING', // waiting for the user; failed attempts may be retried
  SUCCEEDED = 'SUCCEEDED',
  EXPIRED = 'EXPIRED', // time ran out → payment.failed → order cancelled
  REFUNDED = 'REFUNDED', // success arrived after expiry → money returned
}

/*
 * The same idea as the order's State pattern, smaller: a transition table.
 *
 * PENDING ─succeed─► SUCCEEDED
 *    └────expire───► EXPIRED ─(late success)─► REFUNDED
 */
const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.SUCCEEDED, PaymentStatus.EXPIRED],
  [PaymentStatus.EXPIRED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.SUCCEEDED]: [],
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
