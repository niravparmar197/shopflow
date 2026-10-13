import { Injectable } from '@nestjs/common';
import type { OrderHistory } from './rules/rules';

@Injectable()
export class OrderHistoryService implements OrderHistory {
  // There is no orders table until F4. Then this becomes:
  // SELECT count(*) FROM orders WHERE user_id = $1 AND status <> 'CANCELLED'
  // FirstOrderRule itself does not change.
  countPlacedOrders(): Promise<number> {
    return Promise.resolve(0);
  }
}
