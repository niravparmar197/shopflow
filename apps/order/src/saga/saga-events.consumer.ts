import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  InventoryEvents,
  PaymentEvents,
  type PaymentFailedV1,
  PaymentFailedV1Schema,
  type PaymentSucceededV1,
  PaymentSucceededV1Schema,
  type StockFailedV1,
  StockFailedV1Schema,
  type StockReservedV1,
  StockReservedV1Schema,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { OrderSagaService } from './order-saga.service';

/**
 * stock.* and payment.* → move the order on.
 *
 * The group id stays 'order-svc', so Kafka keeps its offsets on
 * inventory-events; payment-events is new to the group and is read from
 * the beginning.
 */
@Injectable()
export class SagaEventsConsumer extends BaseConsumer {
  protected readonly topics = [Topics.INVENTORY_EVENTS, Topics.PAYMENT_EVENTS];
  protected readonly groupId = 'order-svc';
  protected readonly schemas = {
    [InventoryEvents.RESERVED]: StockReservedV1Schema,
    [InventoryEvents.FAILED]: StockFailedV1Schema,
    [PaymentEvents.SUCCEEDED]: PaymentSucceededV1Schema,
    [PaymentEvents.FAILED]: PaymentFailedV1Schema,
  };

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly saga: OrderSagaService,
  ) {
    super(ds, kafka, producer, config);
  }

  protected async handle(m: EntityManager, e: EventEnvelope) {
    switch (e.type) {
      case InventoryEvents.RESERVED:
        return this.saga.onStockReserved(
          m,
          e.data as StockReservedV1,
          e.correlationId,
        );
      case InventoryEvents.FAILED:
        return this.saga.onStockFailed(
          m,
          e.data as StockFailedV1,
          e.correlationId,
        );
      case PaymentEvents.SUCCEEDED:
        return this.saga.onPaymentSucceeded(
          m,
          e.data as PaymentSucceededV1,
          e.correlationId,
        );
      case PaymentEvents.FAILED:
        return this.saga.onPaymentFailed(
          m,
          e.data as PaymentFailedV1,
          e.correlationId,
        );
    }
  }
}
