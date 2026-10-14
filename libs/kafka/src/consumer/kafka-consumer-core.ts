import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanKind } from '@opentelemetry/api';
import type {
  Consumer,
  EachMessagePayload,
  IHeaders,
  Kafka,
  KafkaMessage,
} from 'kafkajs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ZodType } from 'zod';
import type { Env } from '@app/common';
import { EnvelopeSchema, type EventEnvelope } from '@app/events';
import {
  inSpan,
  kafkaProcessed,
  kafkaProcessSeconds,
  restoreTraceContext,
} from '@app/observability';
import { KafkaProducerService } from '../kafka-producer.service';
import { PoisonMessageError } from './poison-message.error';

// Attempt 1 after 1 s, 2 after 5 s, 3 after 15 s, then the dead-letter topic.
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
const START_RETRY_MS = 5_000;
const HEARTBEAT_EVERY_MS = 3_000;

function header(headers: IHeaders | undefined, name: string) {
  const v = headers?.[name];
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v[0] : v)?.toString();
}

/**
 * Template Method, in two layers. This core holds every step that doesn't
 * depend on where the service keeps its state:
 *
 *   1. decode the envelope, find the schema for its type (others are
 *      skipped), check the version and validate the data
 *   2. processEvent(): the one step a subclass fills in
 *   3. commit the Kafka offset, only after step 2 is settled
 *
 *   KafkaConsumerCore
 *     ├─ BaseConsumer           processEvent = Postgres tx + processed_events + handle()
 *     └─ (e.g. notifications)   processEvent = its own dedupe (queue job id, unique index)
 *
 * Failures never block the partition:
 *   - poison (bad JSON / schema / version)  → straight to <group>.dlq
 *   - anything else (DB down, deadlock…)    → <group>.retry after 1 s, 5 s,
 *                                             15 s, then <group>.dlq
 *   - Kafka itself down (can't even reroute) → throw: no commit, kafkajs
 *                                             redelivers
 * The cost: a retried event can run after a newer event of the same
 * aggregate. Handlers stay correct because they're idempotent and the
 * aggregates' state machines reject impossible moves.
 */
export abstract class KafkaConsumerCore
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  private readonly consumers: Consumer[] = [];
  private readonly stopping = new AbortController();

  protected abstract readonly topics: readonly string[];
  protected abstract readonly groupId: string;
  /** The events this consumer handles (v1 data schemas); others are skipped. */
  protected abstract readonly schemas: Readonly<Record<string, ZodType>>;

  /**
   * For a NEW group only (no saved offset): read the topics' history (true)
   * or start from now (false). Stateful services must catch up; a service
   * that only notifies must not replay old events.
   */
  protected readonly fromBeginning: boolean = true;

  /** The step each subclass fills in. event.data is already validated. */
  /** 'duplicate' when it was already handled (counted as such). */
  protected abstract processEvent(
    event: EventEnvelope,
  ): Promise<void | 'duplicate'>;

  constructor(
    private readonly kafka: Kafka,
    private readonly producer: KafkaProducerService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  protected get retryTopic() {
    return `${this.groupId}.retry`;
  }

  protected get dlqTopic() {
    return `${this.groupId}.dlq`;
  }

  onApplicationBootstrap() {
    // Every series exists at 0 from the start: Prometheus' increase() needs
    // an earlier sample, so a counter that first appears at 1 reads as "no
    // increase" and the DLQ alert would never fire.
    for (const eventType of [...Object.keys(this.schemas), 'unknown']) {
      for (const result of ['ok', 'duplicate', 'retry', 'dlq']) {
        kafkaProcessed.inc(
          { group: this.groupId, event_type: eventType, result },
          0,
        );
      }
    }
    if (!this.config.get('KAFKA_CONSUMERS_ENABLED', { infer: true })) return;
    // In the background: the service (HTTP, health) starts even while Kafka
    // is down, and the consumers join once it's back.
    void this.start(this.groupId, this.topics, (p) => this.onMain(p));
    void this.start(`${this.groupId}-retry`, [this.retryTopic], (p) =>
      this.onRetry(p),
    );
  }

  async onModuleDestroy() {
    this.stopping.abort(); // also ends any wait for a retry's due time
    await Promise.all(
      this.consumers.map((c) => c.disconnect().catch(() => undefined)),
    );
  }

  private async start(
    groupId: string,
    topics: readonly string[],
    onMessage: (p: EachMessagePayload) => Promise<void>,
  ) {
    while (!this.stopping.signal.aborted) {
      const consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: 30_000,
        heartbeatInterval: HEARTBEAT_EVERY_MS,
      });
      try {
        await consumer.connect();
        // Only matters for a new group (no saved offset): don't skip old events.
        await consumer.subscribe({
          topics: [...topics],
          fromBeginning: this.fromBeginning,
        });
        await consumer.run({
          autoCommit: false, // committed by hand, once the message is settled
          partitionsConsumedConcurrently: 3,
          eachMessage: async (p) => {
            // If this throws (Kafka down while rerouting), nothing is
            // committed and kafkajs redelivers.
            await onMessage(p);
            await consumer.commitOffsets([
              {
                topic: p.topic,
                partition: p.partition,
                offset: (BigInt(p.message.offset) + 1n).toString(),
              },
            ]);
          },
        });
        this.consumers.push(consumer);
        this.logger.log(`Consuming ${topics.join(', ')} as group ${groupId}`);
        return;
      } catch (err: unknown) {
        this.logger.error(
          { err, topics },
          'Consumer failed to start, retrying',
        );
        await consumer.disconnect().catch(() => undefined);
        await sleep(START_RETRY_MS, undefined, {
          signal: this.stopping.signal,
        }).catch(() => undefined);
      }
    }
  }

  // ---------- main topic ----------
  private async onMain({ topic, message }: EachMessagePayload) {
    try {
      await this.process(message, topic, 0);
    } catch (err) {
      // The topic it really came from: we may read several.
      await this.routeFailure(message, toError(err), 0, topic);
    }
  }

  // ---------- retry topic ----------
  private async onRetry(payload: EachMessagePayload) {
    const { message } = payload;
    const attempt = Number(header(message.headers, 'x-attempt') ?? 1);
    const dueAt = Number(header(message.headers, 'x-retry-at') ?? 0);
    const originalTopic =
      header(message.headers, 'x-original-topic') ?? this.topics[0];

    // Wait until it's due, heartbeating so the group doesn't drop us.
    while (Date.now() < dueAt) {
      await sleep(Math.min(dueAt - Date.now(), HEARTBEAT_EVERY_MS), undefined, {
        signal: this.stopping.signal,
      });
      await payload.heartbeat();
    }

    try {
      // Retry and DLQ messages keep the original headers (traceparent too):
      // a retry shows up INSIDE the same trace.
      await this.process(message, originalTopic, attempt);
      this.logger.log(`Retry attempt ${attempt} succeeded`);
    } catch (err) {
      await this.routeFailure(message, toError(err), attempt, originalTopic);
    }
  }

  // ---------- the template: same steps for main and retry ----------
  private async process(message: KafkaMessage, topic: string, attempt: number) {
    const event = this.decode(message.value);
    // Other event types on these topics aren't for us: just move past them.
    // (hasOwn: a type like "constructor" must not hit Object.prototype)
    if (!Object.hasOwn(this.schemas, event.type)) return;
    const schema = this.schemas[event.type];

    // A CONSUMER span, child of the relay's publish span (Kafka headers), or
    // of the trace saved in the envelope if the headers have none.
    const fromHeaders: Record<string, string> = {};
    for (const name of ['traceparent', 'tracestate']) {
      const v = header(message.headers, name);
      if (v) fromHeaders[name] = v;
    }
    const parent = restoreTraceContext(
      fromHeaders.traceparent ? fromHeaders : event.trace,
    );
    const orderId = (event.data as { orderId?: unknown } | null)?.orderId;

    await inSpan(
      `${topic} process ${event.type}`,
      {
        kind: SpanKind.CONSUMER,
        parent,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.destination.name': topic,
          'messaging.consumer.group.name': this.groupId,
          'messaging.message.id': event.eventId,
          'shopflow.event_type': event.type,
          // Search Jaeger by this tag to find every trace of one order.
          'shopflow.order_id': typeof orderId === 'string' ? orderId : '',
          'shopflow.attempt': attempt,
        },
      },
      async () => {
        const data = this.parseData(schema, event);
        // pg / Redis / Mongo spans nest under this one.
        const stop = kafkaProcessSeconds.startTimer({
          group: this.groupId,
          event_type: event.type,
        });
        const outcome = await this.processEvent({ ...event, data });
        stop();
        kafkaProcessed.inc({
          group: this.groupId,
          event_type: event.type,
          result: outcome ?? 'ok',
        });
      },
    );
  }

  private async routeFailure(
    msg: KafkaMessage,
    err: Error,
    attempt: number,
    originalTopic: string,
  ) {
    const poison = err instanceof PoisonMessageError;
    const headers: IHeaders = {
      ...msg.headers,
      'x-original-topic': originalTopic,
      'x-error': err.message.slice(0, 500),
      'x-failed-at': new Date().toISOString(),
    };

    const eventType = header(msg.headers, 'event-type') ?? 'unknown';
    if (poison || attempt >= RETRY_DELAYS_MS.length) {
      kafkaProcessed.inc({
        group: this.groupId,
        event_type: eventType,
        result: 'dlq',
      });
      await this.producer.send(this.dlqTopic, [
        {
          key: msg.key,
          value: msg.value,
          headers: {
            ...headers,
            'x-attempt': String(attempt),
            // dlq-replay skips poison unless asked: it fails the same way again.
            'x-dlq-reason': poison ? 'poison' : 'retries-exhausted',
          },
        },
      ]);
      this.logger.error(
        `→ DLQ ${this.dlqTopic} (${poison ? 'poison' : `after ${attempt} retries`}): ${err.message}`,
      );
      return;
    }

    kafkaProcessed.inc({
      group: this.groupId,
      event_type: eventType,
      result: 'retry',
    });
    const delay = RETRY_DELAYS_MS[attempt];
    await this.producer.send(this.retryTopic, [
      {
        key: msg.key, // same key → same partition in the retry topic
        value: msg.value,
        headers: {
          ...headers,
          'x-attempt': String(attempt + 1),
          'x-retry-at': String(Date.now() + delay),
        },
      },
    ]);
    this.logger.warn(
      `→ retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay} ms: ${err.message}`,
    );
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

  /** Checks the schema version, then validates the data. */
  private parseData<T>(
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

const toError = (err: unknown) =>
  err instanceof Error ? err : new Error(String(err));
