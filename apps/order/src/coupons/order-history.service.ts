import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Not, Repository } from 'typeorm';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order-status';
import type { OrderHistory } from './rules/coupon-rule';

// Cancelled and failed orders don't count as "used your first order".
const countPlaced = (orders: Repository<Order>, userId: string) =>
  orders.count({
    where: {
      userId,
      status: Not(In([OrderStatus.CANCELLED, OrderStatus.FAILED])),
    },
  });

@Injectable()
export class OrderHistoryService implements OrderHistory {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  countPlacedOrders(userId: string) {
    return countPlaced(this.orders, userId);
  }

  /** The same, read on a transaction's connection. */
  within(manager: EntityManager): OrderHistory {
    const orders = manager.getRepository(Order);
    return { countPlacedOrders: (userId) => countPlaced(orders, userId) };
  }
}
