/** The one shape every event on Kafka has. */
export interface EventEnvelope<T = unknown> {
  eventId: string; // unique; consumers use it to skip duplicates
  type: string; // e.g. 'order.created'
  version: number; // schema version of `data`
  occurredAt: string; // ISO time
  correlationId?: string; // the HTTP request's id, so one trace spans services
  data: T;
}
