import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  type OrderCreatedV1,
  OrderCreatedV1Schema,
  OrderEvents,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT } from '@app/kafka';
import { ReservationService } from './reservation.service';

/** order.created → reserve stock. The steps around it come from BaseConsumer. */
@Injectable()
export class OrderEventsConsumer extends BaseConsumer {
  protected readonly topic = Topics.ORDER_EVENTS;
  protected readonly groupId = 'inventory-svc';
  protected readonly eventTypes = [OrderEvents.CREATED];

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    config: ConfigService<Env, true>,
    private readonly reservations: ReservationService,
  ) {
    super(ds, kafka, config);
  }

  protected parse(event: EventEnvelope) {
    return this.parseData(OrderCreatedV1Schema, event, [1]);
  }

  protected handle(m: EntityManager, event: EventEnvelope<OrderCreatedV1>) {
    return this.reservations.reserveForOrder(
      m,
      event.data,
      event.correlationId,
    );
  }
}
