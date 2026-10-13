import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Message } from 'kafkajs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { topicForEvent } from '@app/events';
import type { Env } from '@app/common';
import { KafkaProducerService } from '../kafka-producer.service';
import { OutboxEvent } from './outbox-event.entity';

const MAX_BACKOFF_MS = 30_000;

/**
 * Polling publisher: sends unpublished outbox rows to Kafka, then marks them
 * published.
 *
 * At least once: if Kafka has the message but marking the row fails (say the
 * pod dies), the row is sent again later. Consumers skip duplicates by
 * eventId.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private stopped = false;
  private readonly abort = new AbortController();
  private loopDone?: Promise<void>;

  constructor(
    private readonly ds: DataSource,
    private readonly producer: KafkaProducerService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.intervalMs = config.get('OUTBOX_POLL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH', { infer: true });
  }

  onApplicationBootstrap() {
    if (this.enabled) this.loopDone = this.loop();
  }

  // Graceful shutdown: stop polling, let the current batch finish.
  async onModuleDestroy() {
    this.stopped = true;
    this.abort.abort();
    await this.loopDone;
  }

  private async loop() {
    let wait = this.intervalMs;
    while (!this.stopped) {
      try {
        const sent = await this.publishBatch();
        wait = this.intervalMs;
        if (sent === this.batchSize) continue; // more waiting: no pause
      } catch (err: unknown) {
        this.logger.error({ err }, 'Outbox publish failed');
        wait = Math.min(wait * 2, MAX_BACKOFF_MS); // Kafka down: back off
      }
      await sleep(wait, undefined, { signal: this.abort.signal }).catch(
        () => undefined,
      );
    }
  }

  /** Sends one batch; returns how many rows were published. */
  async publishBatch(): Promise<number> {
    // Connect before taking row locks, so a Kafka outage fails fast instead
    // of holding a transaction open through the client's retries.
    await this.producer.connect();

    return this.ds.transaction(async (m) => {
      // SKIP LOCKED: several relay instances each take different rows.
      const rows = await m
        .getRepository(OutboxEvent)
        .createQueryBuilder('e')
        .where('e.published_at IS NULL')
        .orderBy('e.created_at', 'ASC')
        .limit(this.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, Message[]>();
      for (const row of rows) {
        const envelope = row.payload;
        const topic = topicForEvent(row.eventType);
        const messages = byTopic.get(topic) ?? [];
        messages.push({
          key: row.aggregateId, // same aggregate → same partition → in order
          value: JSON.stringify(envelope),
          headers: {
            'event-id': row.id,
            'event-type': row.eventType,
            'correlation-id': envelope.correlationId ?? '',
          },
        });
        byTopic.set(topic, messages);
      }

      await this.producer.sendBatch(
        [...byTopic].map(([topic, messages]) => ({ topic, messages })),
      );
      await m
        .createQueryBuilder()
        .update(OutboxEvent)
        .set({ publishedAt: () => 'now()' })
        .whereInIds(rows.map((r) => r.id))
        .execute();

      this.logger.log(`Published ${rows.length} event(s)`);
      return rows.length;
    });
  }
}
