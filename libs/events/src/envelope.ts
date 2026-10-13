import { z } from 'zod';

/** The one shape every event on Kafka has. Consumers validate it on receipt. */
export const EnvelopeSchema = z.object({
  eventId: z.uuid(), // unique; consumers use it to skip duplicates
  type: z.string().min(1), // e.g. 'order.created'
  version: z.number().int().positive(), // schema version of `data`
  occurredAt: z.string(), // ISO time
  correlationId: z.string().optional(), // the HTTP request's id, one trace across services
  data: z.unknown(),
});

export type EventEnvelope<T = unknown> = Omit<
  z.infer<typeof EnvelopeSchema>,
  'data'
> & { data: T };
