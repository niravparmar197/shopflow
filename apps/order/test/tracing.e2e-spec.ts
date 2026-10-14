import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { DataSource } from 'typeorm';
import { OutboxService } from '@app/kafka';
import { eventually } from '../../../test/helpers/kafka';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1);

// A real tracer provider that keeps finished spans in memory: no Jaeger.
// register() also installs the W3C propagator and the async context
// manager, as the NodeSDK does in production. The library's `tracer` is a
// proxy, so it picks this provider up.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

// The outbox and Kafka break the call chain; the trace context is carried
// by hand (envelope `trace`, then the Kafka headers). This proves it holds
// over two hops: outbox → Kafka → consumer → outbox → Kafka.
describe('Tracing across outbox + Kafka (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;

  beforeAll(async () => {
    ctx = await startOrderApp({ kafka: true });
    ctx.catalog.set(product(PHONE, 'Phone', 'phones', 1_000_000));
  });

  afterAll(async () => {
    await ctx?.close();
    await provider.shutdown();
  });

  it('one trace: root → publish → consume → next publish', async () => {
    const auth = ctx.bearer(randomUUID());
    await ctx
      .http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 1 })
      .expect(201);
    const orderId = (
      (
        await ctx
          .http()
          .post('/v1/orders')
          .set('Authorization', auth)
          .set('Idempotency-Key', randomUUID())
          .send({})
          .expect(201)
      ).body as { id: string }
    ).id;

    // Play the inventory service: stock.reserved through the outbox,
    // written INSIDE a root span.
    const ds = ctx.app.get(DataSource);
    const outbox = ctx.app.get(OutboxService);
    const root = await trace
      .getTracer('test')
      .startActiveSpan('test-root', async (span) => {
        await ds.transaction((m) =>
          outbox.add(m, {
            aggregateType: 'inventory',
            aggregateId: orderId,
            eventType: 'stock.reserved',
            data: { orderId, items: [{ productId: PHONE, quantity: 1 }] },
          }),
        );
        span.end();
        return span.spanContext();
      });

    // relay → inventory-events → saga → CONFIRMED → order.confirmed → relay
    let spans: ReadableSpan[] = [];
    const named = (name: string, eventType?: string) =>
      spans.find(
        (s) =>
          s.name === name &&
          (!eventType || s.attributes['shopflow.event_type'] === eventType),
      );
    await eventually(() => {
      spans = exporter
        .getFinishedSpans()
        .filter((s) => s.spanContext().traceId === root.traceId);
      expect(named('inventory-events publish')).toBeDefined();
      expect(named('inventory-events process stock.reserved')).toBeDefined();
      expect(named('order-events publish', 'order.confirmed')).toBeDefined();
      return Promise.resolve();
    }, 30_000);

    const publish1 = named('inventory-events publish')!;
    const consume1 = named('inventory-events process stock.reserved')!;
    const publish2 = named('order-events publish', 'order.confirmed')!;

    // The relay restored the context saved with the outbox row.
    expect(parentOf(publish1)).toBe(root.spanId);
    // The consumer read the traceparent Kafka header.
    expect(parentOf(consume1)).toBe(publish1.spanContext().spanId);
    // Hop 2: the event written by the handler continues the same trace.
    expect(parentOf(publish2)).toBe(consume1.spanContext().spanId);

    expect(consume1.attributes['shopflow.order_id']).toBe(orderId);
    expect(
      Number(publish1.attributes['shopflow.outbox_wait_ms']),
    ).toBeGreaterThanOrEqual(0);
  });
});
