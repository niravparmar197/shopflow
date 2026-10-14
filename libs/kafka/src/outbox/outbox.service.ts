import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { EventEnvelope, topicForEvent } from '@app/events';
import { captureTraceContext } from '@app/observability';
import { OutboxEvent } from './outbox-event.entity';

export interface NewOutboxEvent<T extends object> {
  aggregateType: string;
  aggregateId: string; // also the Kafka message key
  eventType: string;
  data: T;
  version?: number;
  correlationId?: string;
}

@Injectable()
export class OutboxService {
  /**
   * Takes the caller's transaction manager on purpose: with an injected
   * repository the row would be written outside the transaction, and the
   * event could exist without the change it describes (or the other way
   * round).
   */
  async add<T extends object>(
    manager: EntityManager,
    event: NewOutboxEvent<T>,
  ) {
    // Fail now, in the business transaction, rather than in the relay where
    // one bad row would block everything behind it.
    topicForEvent(event.eventType);

    const eventId = randomUUID();
    const envelope: EventEnvelope<T> = {
      eventId,
      type: event.eventType,
      version: event.version ?? 1,
      occurredAt: new Date().toISOString(),
      correlationId: event.correlationId,
      // The request's trace, saved with the row: the relay publishes later,
      // in another loop, and restores it from here.
      trace: captureTraceContext(),
      data: event.data,
    };
    await manager.getRepository(OutboxEvent).insert({
      id: eventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: envelope,
    });
    return eventId;
  }
}
