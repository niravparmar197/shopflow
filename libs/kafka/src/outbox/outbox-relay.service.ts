import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Message } from 'kafkajs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { topicForEvent } from '@app/events';
import type { Env } from '@app/common';
import {
  outboxPublished,
  restoreTraceContext,
  scrapeGauge,
  tracer,
} from '@app/observability';
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

    // Computed when Prometheus scrapes. AGE, not just count: 500 events
    // pending for 0.2 s is a busy, healthy system; 3 events pending for 5
    // minutes means Kafka is down or the relay is stuck.
    scrapeGauge(
      'outbox_pending_events',
      'Events waiting in the outbox',
      [],
      async (g) => {
        const [r] = await this.ds.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
        );
        g.set(r.n);
      },
    );
    scrapeGauge(
      'outbox_oldest_pending_age_seconds',
      'Age of the oldest unpublished event',
      [],
      async (g) => {
        const [r] = await this.ds.query<{ age: string }[]>(
          `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) AS age
             FROM outbox WHERE published_at IS NULL`,
        );
        g.set(Number(r.age));
      },
    );
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

      // One PRODUCER span per message, child of the trace saved in the row
      // (the request that created the event ended long ago).
      const byTopic = new Map<string, Message[]>();
      const spans: Span[] = [];
      for (const row of rows) {
        const envelope = row.payload;
        const topic = topicForEvent(row.eventType);
        const parent = restoreTraceContext(envelope.trace);
        const span = tracer.startSpan(
          `${topic} publish`,
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'kafka',
              'messaging.destination.name': topic,
              'messaging.message.id': row.id,
              'shopflow.event_type': row.eventType,
              'shopflow.order_id': row.aggregateId,
              // How long it waited in the outbox: the gap you see in Jaeger.
              'shopflow.outbox_wait_ms': Date.now() - row.createdAt.getTime(),
            },
          },
          parent,
        );
        spans.push(span);
        // THIS span's context in the Kafka headers: the consumer's span
        // becomes its child.
        const traceHeaders: Record<string, string> = {};
        propagation.inject(trace.setSpan(parent, span), traceHeaders);

        const messages = byTopic.get(topic) ?? [];
        messages.push({
          key: row.aggregateId, // same aggregate → same partition → in order
          value: JSON.stringify(envelope),
          headers: {
            ...traceHeaders,
            'event-id': row.id,
            'event-type': row.eventType,
            'correlation-id': envelope.correlationId ?? '',
          },
        });
        byTopic.set(topic, messages);
      }

      try {
        await this.producer.sendBatch(
          [...byTopic].map(([topic, messages]) => ({ topic, messages })),
        );
      } catch (err) {
        for (const s of spans) {
          s.recordException(err as Error);
          s.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw err;
      } finally {
        spans.forEach((s) => s.end());
      }
      await m
        .createQueryBuilder()
        .update(OutboxEvent)
        .set({ publishedAt: () => 'now()' })
        .whereInIds(rows.map((r) => r.id))
        .execute();

      rows.forEach((r) => outboxPublished.inc({ event_type: r.eventType }));
      this.logger.log(`Published ${rows.length} event(s)`);
      return rows.length;
    });
  }
}
