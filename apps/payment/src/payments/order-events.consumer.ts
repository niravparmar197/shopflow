import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  type OrderConfirmedV1,
  OrderConfirmedV1Schema,
  OrderEvents,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { PaymentsService } from './payments.service';

/** order.confirmed → a payment row. The steps around it come from BaseConsumer. */
@Injectable()
export class OrderEventsConsumer extends BaseConsumer {
  protected readonly topic = Topics.ORDER_EVENTS;
  protected readonly groupId = 'payment-svc';
  protected readonly eventTypes = [OrderEvents.CONFIRMED];

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly payments: PaymentsService,
  ) {
    super(ds, kafka, producer, config);
  }

  protected parse(event: EventEnvelope) {
    return this.parseData(OrderConfirmedV1Schema, event, [1]);
  }

  protected handle(m: EntityManager, event: EventEnvelope<OrderConfirmedV1>) {
    return this.payments.createForOrder(m, event.data, event.correlationId);
  }
}
