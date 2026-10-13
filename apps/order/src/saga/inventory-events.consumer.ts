import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  InventoryEvents,
  type StockFailedV1,
  StockFailedV1Schema,
  type StockReservedV1,
  StockReservedV1Schema,
  Topics,
} from '@app/events';
import { BaseConsumer, KAFKA_CLIENT, KafkaProducerService } from '@app/kafka';
import { OrderSagaService } from './order-saga.service';

/** stock.reserved / stock.failed → move the order on. */
@Injectable()
export class InventoryEventsConsumer extends BaseConsumer {
  protected readonly topic = Topics.INVENTORY_EVENTS;
  protected readonly groupId = 'order-svc';
  protected readonly eventTypes = [
    InventoryEvents.RESERVED,
    InventoryEvents.FAILED,
  ];

  constructor(
    ds: DataSource,
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly saga: OrderSagaService,
  ) {
    super(ds, kafka, producer, config);
  }

  protected parse(event: EventEnvelope) {
    return event.type === InventoryEvents.RESERVED
      ? this.parseData(StockReservedV1Schema, event)
      : this.parseData(StockFailedV1Schema, event);
  }

  protected handle(
    m: EntityManager,
    event: EventEnvelope<StockReservedV1 | StockFailedV1>,
  ) {
    return event.type === InventoryEvents.RESERVED
      ? this.saga.onStockReserved(
          m,
          event.data as StockReservedV1,
          event.correlationId,
        )
      : this.saga.onStockFailed(
          m,
          event.data as StockFailedV1,
          event.correlationId,
        );
  }
}
