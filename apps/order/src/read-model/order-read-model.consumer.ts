import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  OrderCancelledV1Schema,
  OrderConfirmedV1Schema,
  OrderCreatedV1Schema,
  OrderDeliveredV1Schema,
  OrderEvents,
  OrderFailedV1Schema,
  OrderPaidV1Schema,
  OrderShippedV1Schema,
  PaymentEvents,
  PaymentFailedV1Schema,
  PaymentRefundedV1Schema,
  PaymentSucceededV1Schema,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { OrderViewProjector } from './order-view.projector';

/**
 * order-events + payment-events → order_views.
 *
 * Its own group, separate from 'order-svc': its offsets can be reset to
 * rebuild the view without touching the saga.
 */
@Injectable()
export class OrderReadModelConsumer extends BaseConsumer {
  protected readonly topics = [Topics.ORDER_EVENTS, Topics.PAYMENT_EVENTS];
  protected readonly groupId = 'order-read-model';
  protected readonly schemas = {
    [OrderEvents.CREATED]: OrderCreatedV1Schema,
    [OrderEvents.CONFIRMED]: OrderConfirmedV1Schema,
    [OrderEvents.FAILED]: OrderFailedV1Schema,
    [OrderEvents.PAID]: OrderPaidV1Schema,
    [OrderEvents.CANCELLED]: OrderCancelledV1Schema,
    [OrderEvents.SHIPPED]: OrderShippedV1Schema,
    [OrderEvents.DELIVERED]: OrderDeliveredV1Schema,
    [PaymentEvents.SUCCEEDED]: PaymentSucceededV1Schema,
    [PaymentEvents.FAILED]: PaymentFailedV1Schema,
    [PaymentEvents.REFUNDED]: PaymentRefundedV1Schema,
  };

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly projector: OrderViewProjector,
  ) {
    super(ds, kafka, producer, config);
  }

  protected handle(m: EntityManager, e: EventEnvelope) {
    return this.projector.apply(m, e);
  }
}
