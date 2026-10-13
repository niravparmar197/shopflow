import { OutboxEvent, ProcessedEvent } from '@app/kafka';
import { Reservation } from '../reservations/reservation.entity';
import { Stock } from '../stock/stock.entity';

// Used by both the running service (inventory.module.ts) and the migration CLI.
export const INVENTORY_ENTITIES = [
  Stock,
  Reservation,
  OutboxEvent,
  ProcessedEvent,
];
