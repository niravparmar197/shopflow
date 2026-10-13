// Creates the Kafka topics if they are missing. Safe to run many times.
// Keep the list in sync with libs/events/src/topics.ts.
//
//   npm run kafka:topics
//   KAFKA_BROKERS=b1:9092,b2:9092 KAFKA_RF=3 npm run kafka:topics   (production)
const { Kafka, logLevel } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
// 3 partitions: up to 3 consumers of one group work in parallel; the key
// (e.g. orderId) still keeps each aggregate's events in order.
const partitions = Number(process.env.KAFKA_PARTITIONS || 3);
const replicationFactor = Number(process.env.KAFKA_RF || 1); // 1 locally, 3 in production

const TOPICS = ['order-events', 'inventory-events', 'payment-events'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const admin = new Kafka({
    clientId: 'topic-setup',
    brokers,
    logLevel: logLevel.WARN,
  }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = TOPICS.filter((t) => !existing.has(t));
    if (missing.length) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: missing.map((topic) => ({
          topic,
          numPartitions: partitions,
          replicationFactor,
          configEntries: [
            { name: 'retention.ms', value: String(SEVEN_DAYS_MS) },
            // With acks=all, a write needs this many replicas: 1 locally, 2 in production.
            {
              name: 'min.insync.replicas',
              value: String(Math.min(2, replicationFactor)),
            },
          ],
        })),
      });
    }
    const present = TOPICS.filter((t) => existing.has(t));
    console.log(
      `created: [${missing.join(', ')}], already there: [${present.join(', ')}]`,
    );
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
