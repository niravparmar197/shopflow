import { KafkaContainer } from '@testcontainers/kafka';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type IHeaders, Kafka, type KafkaMessage, logLevel } from 'kafkajs';
import { Wait } from 'testcontainers';
import { ALL_TOPICS } from '@app/events';

// Shared by the e2e suites of every service that talks to Kafka.

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
// Kafka hands clients the address it was started with ("localhost" by
// default). On Windows "localhost" resolves to ::1 first, where Docker
// Desktop accepts and then drops the connection, so use 127.0.0.1 instead.
// Must be set before the first container starts.
if (process.platform === 'win32') {
  process.env.TESTCONTAINERS_HOST_OVERRIDE ??= '127.0.0.1';
}

/** A real single-node Kafka (KRaft, no ZooKeeper) with every topic created. */
export async function startKafka() {
  const container = await new KafkaContainer('confluentinc/cp-kafka:7.6.1')
    .withKraft()
    // The default (port open) passes too early on Docker Desktop, whose port
    // proxy accepts connections before the broker listens.
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .start();
  const brokers = [`${container.getHost()}:${container.getMappedPort(9093)}`];

  // The services never auto-create topics, so create them like
  // scripts/kafka-topics.js does in real environments.
  const admin = new Kafka({
    clientId: 'test-admin',
    brokers,
    logLevel: logLevel.NOTHING,
  }).admin();
  await admin.connect();
  await admin.createTopics({
    topics: ALL_TOPICS.map((topic) => ({
      topic,
      numPartitions: 3,
      replicationFactor: 1,
    })),
    waitForLeaders: true,
  });
  await admin.disconnect();

  return { container, brokers };
}

/** A valid event envelope; `overrides` replace top-level fields. */
export function envelope<T>(
  type: string,
  data: T,
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'test',
    data,
    ...overrides,
  };
}

export function header(headers: IHeaders | undefined, name: string) {
  const v = headers?.[name];
  return (Array.isArray(v) ? v[0] : v)?.toString();
}

/**
 * Reads `topic` from the start with a fresh group, keeps only messages with
 * this key, and resolves once `count` of them have arrived.
 */
export async function readTopic(
  brokers: string[],
  topic: string,
  opts: { key: string; count?: number; timeoutMs?: number },
): Promise<KafkaMessage[]> {
  const { key, count = 1, timeoutMs = 30_000 } = opts;
  const consumer = new Kafka({
    clientId: 'test-reader',
    brokers,
    logLevel: logLevel.NOTHING,
  }).consumer({ groupId: `test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  const got: KafkaMessage[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timeout: ${got.length}/${count} messages with key ${key} on ${topic}`,
            ),
          ),
        timeoutMs,
      );
      consumer
        .run({
          eachMessage: ({ message }) => {
            if (message.key?.toString() === key) got.push(message);
            if (got.length >= count) {
              clearTimeout(timer);
              resolve();
            }
            return Promise.resolve();
          },
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  } finally {
    await consumer.disconnect();
  }
  return got.slice(0, count);
}

/**
 * Events take effect some time after send() returns. Retries the assertion
 * until it passes or time runs out: faster than a fixed sleep, and not flaky.
 */
export async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 20_000,
  everyMs = 200,
) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() >= end) throw err;
      await sleep(everyMs);
    }
  }
}
