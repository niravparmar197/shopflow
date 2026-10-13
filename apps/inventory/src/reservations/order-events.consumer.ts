import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  type OrderCancelledV1,
  OrderCancelledV1Schema,
  type OrderCreatedV1,
  OrderCreatedV1Schema,
  OrderEvents,
  type OrderPaidV1,
  OrderPaidV1Schema,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { ReservationService } from './reservation.service';

/**
 * order.created → reserve, order.paid → commit, order.cancelled → release.
 * The steps around it come from BaseConsumer.
 */
@Injectable()
export class OrderEventsConsumer extends BaseConsumer {
  protected readonly topics = [Topics.ORDER_EVENTS];
  protected readonly groupId = 'inventory-svc';
  protected readonly schemas = {
    [OrderEvents.CREATED]: OrderCreatedV1Schema,
    [OrderEvents.PAID]: OrderPaidV1Schema,
    [OrderEvents.CANCELLED]: OrderCancelledV1Schema,
  };

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly reservations: ReservationService,
  ) {
    super(ds, kafka, producer, config);
  }

  protected async handle(m: EntityManager, e: EventEnvelope) {
    switch (e.type) {
      case OrderEvents.CREATED:
        return this.reservations.reserveForOrder(
          m,
          e.data as OrderCreatedV1,
          e.correlationId,
        );
      case OrderEvents.PAID:
        return this.reservations.commit(m, (e.data as OrderPaidV1).orderId);
      case OrderEvents.CANCELLED:
        return this.reservations.release(
          m,
          (e.data as OrderCancelledV1).orderId,
          (e.data as OrderCancelledV1).userId,
        );
    }
  }
}
