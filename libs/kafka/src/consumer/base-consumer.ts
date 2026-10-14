import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import type { EventEnvelope } from '@app/events';
import { KafkaProducerService } from '../kafka-producer.service';
import { KafkaConsumerCore } from './kafka-consumer-core';
import { ProcessedEvent } from './processed-event.entity';

/**
 * A side effect outside the database (Redis, HTTP…) that handle() wants run
 * only AFTER its transaction committed. Run inside, a rollback + retry would
 * repeat it (e.g. put a flash-sale item back on sale twice).
 */
export type AfterCommit = () => Promise<void>;

/**
 * For services with PostgreSQL: the event id goes into processed_events in
 * the SAME transaction as handle()'s changes (already there → duplicate,
 * skipped). Exactly-once effect on top of at-least-once delivery.
 * The rest of the steps (decode, validate, retry, DLQ, commit) come from
 * KafkaConsumerCore.
 */
export abstract class BaseConsumer extends KafkaConsumerCore {
  /** Business logic, inside the transaction: write only through `m`.
   *  event.data has already been validated against schemas[event.type].
   *  May return an AfterCommit step for side effects outside the DB. */
  protected abstract handle(
    m: EntityManager,
    event: EventEnvelope,
  ): Promise<void | AfterCommit>;

  constructor(
    protected readonly ds: DataSource,
    kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
  ) {
    super(kafka, producer, config);
  }

  protected async processEvent(event: EventEnvelope) {
    const after = await this.ds.transaction(
      async (m): Promise<AfterCommit | 'duplicate' | void> => {
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
          return 'duplicate';
        }
        return this.handle(m, event);
      },
    );
    if (after === 'duplicate') return 'duplicate';

    if (after) {
      // Once, after the commit. A crash right here loses it: choose side
      // effects whose loss is the SAFE direction (a flash-sale token not
      // returned = one unit undersold, never oversold). Its failure doesn't
      // fail the event: the DB change is already committed.
      await after().catch((err: unknown) =>
        this.logger.error(
          { err },
          `After-commit step for ${event.type} ${event.eventId} failed`,
        ),
      );
    }
  }
}
