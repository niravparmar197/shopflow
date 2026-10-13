import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  type Metric,
  Registry,
} from 'prom-client';

/** One registry per process; GET /metrics serves it to Prometheus. */
export const registry = new Registry();
let started = false;

/** Labels every metric with service="order" etc., and adds Node's own (USE). */
export function initMetrics(service: string) {
  if (started) return;
  started = true;
  registry.setDefaultLabels({ service });
  // CPU, memory, GC, event-loop lag (nodejs_eventloop_lag_p99_seconds…).
  collectDefaultMetrics({ register: registry });
}

/**
 * The same name twice (e.g. 3 app copies in one test process) → reuse the
 * metric instead of crashing with "already registered".
 */
export function getOrCreate<T extends Metric>(
  name: string,
  create: () => T,
): T {
  return (registry.getSingleMetric(name) as T | undefined) ?? create();
}

// ---------- RED: HTTP (rate, errors, duration) ----------
export const httpDuration = getOrCreate(
  'http_server_request_duration_seconds',
  () =>
    new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status_code'],
      // 0.8 = the p95 goal: a bucket boundary there makes it exact.
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2.5, 5],
      registers: [registry],
    }),
);

// ---------- Kafka consumers ----------
export const kafkaProcessed = getOrCreate(
  'kafka_messages_processed_total',
  () =>
    new Counter({
      name: 'kafka_messages_processed_total',
      help: 'Messages handled by consumers',
      labelNames: ['group', 'event_type', 'result'], // ok | duplicate | retry | dlq
      registers: [registry],
    }),
);

export const kafkaProcessSeconds = getOrCreate(
  'kafka_message_process_seconds',
  () =>
    new Histogram({
      name: 'kafka_message_process_seconds',
      help: 'Time to handle one message',
      labelNames: ['group', 'event_type'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [registry],
    }),
);

export const outboxPublished = getOrCreate(
  'outbox_published_total',
  () =>
    new Counter({
      name: 'outbox_published_total',
      help: 'Events sent to Kafka by the outbox relay',
      labelNames: ['event_type'],
      registers: [registry],
    }),
);

/** A gauge computed WHEN Prometheus scrapes (e.g. a DB count). */
export function scrapeGauge(
  name: string,
  help: string,
  labelNames: string[],
  collect: (g: Gauge) => Promise<void>,
) {
  return getOrCreate(
    name,
    () =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: [registry],
        async collect() {
          // A failing source (DB down) must not break the whole scrape.
          await collect(this).catch(() => undefined);
        },
      }),
  );
}

/** A counter with fixed labels, created once per process. */
export const counter = (
  name: string,
  help: string,
  labelNames: string[] = [],
) =>
  getOrCreate(
    name,
    () => new Counter({ name, help, labelNames, registers: [registry] }),
  );
