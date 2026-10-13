import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource, EntityManager } from 'typeorm';
import type { ZodType } from 'zod';
import type { Env } from '@app/common';
import { EnvelopeSchema, type EventEnvelope } from '@app/events';
import { ProcessedEvent } from './processed-event.entity';
import { PoisonMessageError } from './poison-message.error';

const START_RETRY_MS = 5_000;

/**
 * Template Method: onMessage() fixes the steps every consumer takes; a
 * subclass only says what to read (topic, groupId, eventTypes), how to
 * validate it (parse) and what to do (handle).
 *
 *   1. decode + validate the envelope and data (bad → poison, skipped)
 *   2. one transaction: record the event in processed_events (already
 *      there → duplicate, skipped) + handle()
 *   3. commit the Kafka offset, only after the DB commit
 *
 * A crash between 2 and 3 redelivers the message, and step 2 skips it: at
 * least once from Kafka, effectively once in the database.
 */
export abstract class BaseConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  private consumer?: Consumer;
  private stopped = false;

  protected abstract readonly topic: string;
  protected abstract readonly groupId: string;
  protected abstract readonly eventTypes: readonly string[];

  /** Validates event.data; throws PoisonMessageError if it's bad. */
  protected abstract parse(event: EventEnvelope): unknown;

  /** Business logic, inside the transaction: write only through `m`. */
  protected abstract handle(
    m: EntityManager,
    event: EventEnvelope<unknown>,
  ): Promise<void>;

  constructor(
    protected readonly ds: DataSource,
    private readonly kafka: Kafka,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.get('KAFKA_CONSUMERS_ENABLED', { infer: true })) return;
    // In the background: the service (HTTP, health) starts even while Kafka
    // is down, and the consumer joins once it's back.
    void this.start();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.consumer?.disconnect().catch(() => undefined);
  }

  private async start() {
    while (!this.stopped) {
      try {
        this.consumer = this.kafka.consumer({
          groupId: this.groupId,
          sessionTimeout: 30_000,
          heartbeatInterval: 3_000,
        });
        await this.consumer.connect();
        // Only matters for a new group (no saved offset): don't skip old events.
        await this.consumer.subscribe({
          topic: this.topic,
          fromBeginning: true,
        });
        await this.consumer.run({
          autoCommit: false, // committed by hand, after the DB commit
          partitionsConsumedConcurrently: 3,
          eachMessage: (payload) => this.onMessage(payload),
        });
        this.logger.log(`Consuming ${this.topic} as group ${this.groupId}`);
        return;
      } catch (err: unknown) {
        this.logger.error({ err }, 'Consumer failed to start, retrying');
        await this.consumer?.disconnect().catch(() => undefined);
        await sleep(START_RETRY_MS);
      }
    }
  }

  // ---------- the template ----------
  private async onMessage({ topic, partition, message }: EachMessagePayload) {
    try {
      const event = this.decode(message.value);
      // Other event types on this topic aren't for us: just move past them.
      if (this.eventTypes.includes(event.type)) {
        const data = this.parse(event);
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
            this.logger.warn(
              `Duplicate ${event.type} ${event.eventId}, skipped`,
            );
            return;
          }
          await this.handle(m, { ...event, data });
        });
      }
    } catch (err) {
      if (!(err instanceof PoisonMessageError)) {
        // Temporary (DB down, deadlock…): don't commit; kafkajs redelivers.
        throw err;
      }
      this.logger.error(
        `Poison message at ${topic}[${partition}]@${message.offset}: ${err.message}`,
      );
      // Part 3: publish it to the dead-letter topic here.
    }

    // The committed offset is the next one to read.
    await this.consumer!.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private decode(value: Buffer | null): EventEnvelope {
    if (!value) throw new PoisonMessageError('Empty message');
    let json: unknown;
    try {
      json = JSON.parse(value.toString());
    } catch {
      throw new PoisonMessageError('Not valid JSON');
    }
    const result = EnvelopeSchema.safeParse(json);
    if (!result.success) {
      throw new PoisonMessageError(`Bad envelope: ${result.error.message}`);
    }
    return result.data;
  }

  /** For parse(): checks the schema version, then validates the data. */
  protected parseData<T>(
    schema: ZodType<T>,
    event: EventEnvelope,
    versions: number[] = [1],
  ): T {
    if (!versions.includes(event.version)) {
      throw new PoisonMessageError(
        `Unsupported version ${event.version} of ${event.type}`,
      );
    }
    const result = schema.safeParse(event.data);
    if (!result.success) {
      throw new PoisonMessageError(
        `Invalid ${event.type}: ${result.error.message}`,
      );
    }
    return result.data;
  }
}
