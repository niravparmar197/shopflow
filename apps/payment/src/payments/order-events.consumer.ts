import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  type OrderCancelledV1,
  OrderCancelledV1Schema,
  type OrderConfirmedV1,
  OrderConfirmedV1Schema,
  OrderEvents,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { PaymentsService } from './payments.service';

/**
 * order.confirmed → a payment row; order.cancelled → expire or refund it.
 * The steps around it come from BaseConsumer.
 */
@Injectable()
export class OrderEventsConsumer extends BaseConsumer {
  protected readonly topics = [Topics.ORDER_EVENTS];
  protected readonly groupId = 'payment-svc';
  protected readonly schemas = {
    [OrderEvents.CONFIRMED]: OrderConfirmedV1Schema,
    [OrderEvents.CANCELLED]: OrderCancelledV1Schema,
  };

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly payments: PaymentsService,
  ) {
    super(ds, kafka, producer, config);
  }

  protected async handle(m: EntityManager, e: EventEnvelope) {
    switch (e.type) {
      case OrderEvents.CONFIRMED:
        return this.payments.createForOrder(
          m,
          e.data as OrderConfirmedV1,
          e.correlationId,
        );
      case OrderEvents.CANCELLED:
        return this.payments.onOrderCancelled(m, e.data as OrderCancelledV1);
    }
  }
}
