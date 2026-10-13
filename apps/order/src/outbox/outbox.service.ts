import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { OutboxEvent } from './outbox-event.entity';

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  /**
   * Takes the caller's transaction manager on purpose: with an injected
   * repository the row would be written outside the transaction, and the
   * event could exist without its order (or the other way round).
   */
  async add(manager: EntityManager, event: NewOutboxEvent): Promise<string> {
    const id = randomUUID();
    await manager.getRepository(OutboxEvent).insert({
      id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: {
        eventId: id, // consumers use it to skip duplicates (F5)
        eventType: event.eventType,
        schemaVersion: 1, // lets the event shape change later
        occurredAt: new Date().toISOString(),
        ...event.payload,
      },
    });
    return id;
  }
}
