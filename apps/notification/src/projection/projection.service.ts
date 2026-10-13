import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { OrderCreatedV1 } from '@app/events';
import { OrderView } from './order-view.schema';

@Injectable()
export class ProjectionService {
  constructor(
    @InjectModel(OrderView.name) private readonly views: Model<OrderView>,
  ) {}

  /** Upsert by _id = orderId: running it twice gives the same result. */
  async upsertOrder(o: OrderCreatedV1, occurredAt: string) {
    await this.views.updateOne(
      { _id: o.orderId },
      {
        $set: {
          userId: o.userId,
          email: o.customerEmail,
          totalPaise: o.totalPaise,
          currency: o.currency,
          itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
          placedAt: new Date(occurredAt),
        },
      },
      { upsert: true },
    );
  }

  get(orderId: string) {
    return this.views.findById(orderId).lean<OrderView>().exec();
  }
}
