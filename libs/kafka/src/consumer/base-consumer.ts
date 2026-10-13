import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import type { EventEnvelope } from '@app/events';
import { KafkaProducerService } from '../kafka-producer.service';
import { KafkaConsumerCore } from './kafka-consumer-core';
import { ProcessedEvent } from './processed-event.entity';

/**
 * For services with PostgreSQL: the event id goes into processed_events in
 * the SAME transaction as handle()'s changes (already there → duplicate,
 * skipped). Exactly-once effect on top of at-least-once delivery.
 * The rest of the steps (decode, validate, retry, DLQ, commit) come from
 * KafkaConsumerCore.
 */
export abstract class BaseConsumer extends KafkaConsumerCore {
  /** Business logic, inside the transaction: write only through `m`.
   *  event.data has already been validated against schemas[event.type]. */
  protected abstract handle(
    m: EntityManager,
    event: EventEnvelope,
  ): Promise<void>;

  constructor(
    protected readonly ds: DataSource,
    kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
  ) {
    super(kafka, producer, config);
  }

  protected async processEvent(event: EventEnvelope) {
    await this.ds.transaction(async (m) => {
      const fresh = await m
        .createQueryBuilder()
        .insert()
        .into(ProcessedEvent)
        .values({ consumer: this.groupId, eventId: event.eventId })
        .orIgnore()
        .returning(['eventId'])
        .execute();
      if ((fresh.raw as unknown[]).length === 0) {
        this.logger.warn(`Duplicate ${event.type} ${event.eventId}, skipped`);
        return;
      }
      await this.handle(m, event);
    });
  }
}
