import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('shopflow');

/**
 * The current trace context as plain strings ({ traceparent: '00-…' }),
 * safe to store in JSON: an outbox row, a queued job. Auto-instrumentation
 * only follows DIRECT calls; across an async hop we carry it ourselves.
 */
export function captureTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Stored strings (or Kafka headers) back into a parent context. */
export function restoreTraceContext(
  carrier?: Record<string, string | undefined>,
): Context {
  return propagation.extract(ROOT_CONTEXT, carrier ?? {});
}

const NO_TRACE = '00000000000000000000000000000000';

/** The current request's trace id, for logs and error bodies. */
export function currentTraceId(): string | undefined {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && id !== NO_TRACE ? id : undefined;
}

/** Runs fn in a new span (child of `parent`), marks errors, always ends it. */
export function inSpan<T>(
  name: string,
  opts: {
    kind?: SpanKind;
    parent?: Context;
    attributes?: Record<string, string | number>;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes },
    opts.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
