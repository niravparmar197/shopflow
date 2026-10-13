import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let started = false;

/**
 * Starts OpenTelemetry tracing. MUST run before Nest, express, pg, ioredis…
 * are loaded: auto-instrumentation works by patching those modules when they
 * are first required. Each app calls it from its own tracing.ts, imported on
 * the FIRST line of main.ts.
 *
 * Off when OTEL_ENABLED=false or NODE_ENV=test; the helpers then use a no-op
 * tracer (cheap, safe).
 */
export function startTracing(serviceName: string) {
  if (
    started ||
    process.env.OTEL_ENABLED === 'false' ||
    process.env.NODE_ENV === 'test'
  ) {
    return;
  }
  started = true;

  process.env.OTEL_SERVICE_NAME ??= `shopflow-${serviceName}`;
  // PARENT-BASED: the edge (gateway) decides "keep this trace?" once and every
  // service follows the flag in traceparent, so there are no half traces.
  // 100 % locally; in production e.g. OTEL_TRACES_SAMPLER_ARG=0.1.
  process.env.OTEL_TRACES_SAMPLER ??= 'parentbased_traceidratio';
  process.env.OTEL_TRACES_SAMPLER_ARG ??= '1.0';

  const sdk = new NodeSDK({
    // OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318 (Jaeger).
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Thousands of useless spans:
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health checks and metric scrapes every few seconds = noise.
          ignoreIncomingRequestHook: (req) =>
            /^\/(health|metrics)/.test(req.url ?? ''),
        },
        // Only inside a trace: the outbox relay polls Postgres every 500 ms,
        // BullMQ and the schedulers poll Redis; without a parent each query
        // would be its own one-span trace.
        '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
        '@opentelemetry/instrumentation-mongodb': { requireParentSpan: true },
        '@opentelemetry/instrumentation-mongoose': { requireParentSpan: true },
        // Off: we carry the context through the outbox by hand (one batch
        // holds messages from many traces); its own spans and headers would
        // compete with ours.
        '@opentelemetry/instrumentation-kafkajs': { enabled: false },
      }),
    ],
  });
  sdk.start();

  // Flush the last spans on shutdown (Kubernetes sends SIGTERM).
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
