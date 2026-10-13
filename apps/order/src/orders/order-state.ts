import { ConflictException } from '@nestjs/common';
import { OrderAction, OrderStatus } from './order-status';

/*
 * State pattern: each status is a class that decides which moves it allows.
 * All the transition rules live here instead of in ifs across the codebase.
 *
 * PENDING ─confirm─► CONFIRMED ─pay─► PAID ─ship─► SHIPPED ─deliver─► DELIVERED
 *    │                   │              │
 *    ├─cancel/fail       ├─cancel/fail  └─cancel (refund in F6)
 *    ▼                   ▼              ▼
 * CANCELLED / FAILED  CANCELLED / FAILED  CANCELLED
 */
interface OrderState {
  readonly status: OrderStatus;
  confirm(): OrderStatus;
  pay(): OrderStatus;
  ship(): OrderStatus;
  deliver(): OrderStatus;
  cancel(): OrderStatus;
  fail(): OrderStatus;
}

// Denies everything; each state overrides only the moves it allows.
abstract class BaseState implements OrderState {
  abstract readonly status: OrderStatus;

  confirm(): OrderStatus {
    return this.deny('confirm');
  }
  pay(): OrderStatus {
    return this.deny('pay');
  }
  ship(): OrderStatus {
    return this.deny('ship');
  }
  deliver(): OrderStatus {
    return this.deny('deliver');
  }
  cancel(): OrderStatus {
    return this.deny('cancel');
  }
  fail(): OrderStatus {
    return this.deny('fail');
  }

  protected deny(action: OrderAction): never {
    throw new ConflictException({
      code: 'INVALID_ORDER_TRANSITION',
      message: `Cannot ${action} an order that is ${this.status}`,
    });
  }
}

class PendingState extends BaseState {
  readonly status = OrderStatus.PENDING;
  confirm(): OrderStatus {
    return OrderStatus.CONFIRMED;
  }
  cancel(): OrderStatus {
    return OrderStatus.CANCELLED;
  }
  fail(): OrderStatus {
    return OrderStatus.FAILED;
  }
}

class ConfirmedState extends BaseState {
  readonly status = OrderStatus.CONFIRMED;
  pay(): OrderStatus {
    return OrderStatus.PAID;
  }
  cancel(): OrderStatus {
    return OrderStatus.CANCELLED;
  }
  fail(): OrderStatus {
    return OrderStatus.FAILED;
  }
}

class PaidState extends BaseState {
  readonly status = OrderStatus.PAID;
  ship(): OrderStatus {
    return OrderStatus.SHIPPED;
  }
  cancel(): OrderStatus {
    return OrderStatus.CANCELLED;
  }
}

class ShippedState extends BaseState {
  readonly status = OrderStatus.SHIPPED;
  deliver(): OrderStatus {
    return OrderStatus.DELIVERED;
  }
}

// End states: every move is denied.
class DeliveredState extends BaseState {
  readonly status = OrderStatus.DELIVERED;
}
class CancelledState extends BaseState {
  readonly status = OrderStatus.CANCELLED;
}
class FailedState extends BaseState {
  readonly status = OrderStatus.FAILED;
}

const STATES: Record<OrderStatus, OrderState> = {
  [OrderStatus.PENDING]: new PendingState(),
  [OrderStatus.CONFIRMED]: new ConfirmedState(),
  [OrderStatus.PAID]: new PaidState(),
  [OrderStatus.SHIPPED]: new ShippedState(),
  [OrderStatus.DELIVERED]: new DeliveredState(),
  [OrderStatus.CANCELLED]: new CancelledState(),
  [OrderStatus.FAILED]: new FailedState(),
};

/** The status after `action`, or a 409 INVALID_ORDER_TRANSITION. */
export function nextStatus(
  current: OrderStatus,
  action: OrderAction,
): OrderStatus {
  return STATES[current][action]();
}
