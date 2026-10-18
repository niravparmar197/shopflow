// Creates the Kafka topics if they are missing. Safe to run many times.
// Keep the list in sync with libs/events/src/topics.ts (ALL_TOPICS).
//
//   npm run kafka:topics
//   KAFKA_BROKERS=b1:9092,b2:9092 KAFKA_RF=3 npm run kafka:topics   (production)
const { Kafka, logLevel } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
// 3 partitions: up to 3 consumers of one group work in parallel; the key
// (e.g. orderId) still keeps each aggregate's events in order.
const partitions = Number(process.env.KAFKA_PARTITIONS || 3);
const replicationFactor = Number(process.env.KAFKA_RF || 1); // 1 locally, 3 in production

const DAY_MS = 24 * 60 * 60 * 1000;
const TOPICS = [
  { name: 'order-events', retentionMs: 7 * DAY_MS },
  { name: 'inventory-events', retentionMs: 7 * DAY_MS },
  { name: 'payment-events', retentionMs: 7 * DAY_MS },
  // Short: reset / verify links inside expire in a day anyway.
  { name: 'user-events', retentionMs: 1 * DAY_MS },
  // Per consumer group: <group>.retry and <group>.dlq (see BaseConsumer).
  { name: 'inventory-svc.retry', retentionMs: 7 * DAY_MS },
  { name: 'inventory-svc.dlq', retentionMs: 14 * DAY_MS }, // longer: a human must look
  { name: 'order-svc.retry', retentionMs: 7 * DAY_MS },
  { name: 'order-svc.dlq', retentionMs: 14 * DAY_MS },
  { name: 'order-read-model.retry', retentionMs: 7 * DAY_MS },
  { name: 'order-read-model.dlq', retentionMs: 14 * DAY_MS },
  { name: 'payment-svc.retry', retentionMs: 7 * DAY_MS },
  { name: 'payment-svc.dlq', retentionMs: 14 * DAY_MS },
  { name: 'notification-svc.retry', retentionMs: 7 * DAY_MS },
  { name: 'notification-svc.dlq', retentionMs: 14 * DAY_MS },
];

async function main() {
  const admin = new Kafka({
    clientId: 'topic-setup',
    brokers,
    logLevel: logLevel.WARN,
  }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = TOPICS.filter((t) => !existing.has(t.name));
    if (missing.length) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: missing.map((t) => ({
          topic: t.name,
          numPartitions: partitions,
          replicationFactor,
          configEntries: [
            { name: 'retention.ms', value: String(t.retentionMs) },
            // With acks=all, a write needs this many replicas: 1 locally, 2 in production.
            {
              name: 'min.insync.replicas',
              value: String(Math.min(2, replicationFactor)),
            },
          ],
        })),
      });
    }
    const names = (list) => list.map((t) => t.name).join(', ');
    const present = TOPICS.filter((t) => existing.has(t.name));
    console.log(
      `created: [${names(missing)}], already there: [${names(present)}]`,
    );
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
