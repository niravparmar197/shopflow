// Sends a consumer group's dead-lettered messages back to their original
// topic. Run it only after fixing what made them fail.
//
//   npm run dlq:replay -- inventory-svc
//   npm run dlq:replay -- inventory-svc --include-poison
//
// Replays only what was in the DLQ when it started, then exits: a message
// that fails again lands in the DLQ as a new message and waits for the next
// run (otherwise a still-failing message would loop forever while the
// consumer is running). Poison messages (bad JSON / schema) are skipped
// unless --include-poison is given, e.g. after deploying a code change that
// can handle them.
//
// The replay group (<group>-dlq-replay) commits after each re-send, so a
// crash never skips a message; at worst one is sent twice, which consumers
// ignore (processed_events).
const { Kafka, logLevel, Partitioners } = require('kafkajs');

const args = process.argv.slice(2);
const group = args.find((a) => !a.startsWith('--'));
const includePoison = args.includes('--include-poison');
if (!group) {
  console.error(
    'Usage: npm run dlq:replay -- <consumer-group> [--include-poison]',
  );
  process.exit(1);
}
const dlq = `${group}.dlq`;
const replayGroup = `${group}-dlq-replay`;

const kafka = new Kafka({
  clientId: 'dlq-replay',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
});

const header = (headers, name) => headers?.[name]?.toString();

async function main() {
  // Snapshot: per partition, where this run starts and where it stops.
  const admin = kafka.admin();
  await admin.connect();
  const ends = await admin.fetchTopicOffsets(dlq);
  const [committed] = await admin.fetchOffsets({
    groupId: replayGroup,
    topics: [dlq],
  });
  await admin.disconnect();

  const stopAt = new Map(ends.map((p) => [p.partition, BigInt(p.high)]));
  let pending = 0n;
  for (const p of ends) {
    const done = committed.partitions.find((c) => c.partition === p.partition);
    const from = BigInt(done && done.offset !== '-1' ? done.offset : p.low);
    if (BigInt(p.high) > from) pending += BigInt(p.high) - from;
  }
  if (pending === 0n) {
    console.log(`Nothing to replay in ${dlq}`);
    return;
  }

  const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner, // same as the services
  });
  const consumer = kafka.consumer({ groupId: replayGroup });
  await Promise.all([producer.connect(), consumer.connect()]);
  await consumer.subscribe({ topic: dlq, fromBeginning: true });

  let seen = 0n;
  let replayed = 0;
  let skipped = 0;
  await new Promise((resolve, reject) => {
    consumer
      .run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          // Arrived after the snapshot: leave it (uncommitted) for next time.
          if (BigInt(message.offset) >= stopAt.get(partition)) {
            consumer.pause([{ topic: dlq, partitions: [partition] }]);
            return;
          }
          const headers = message.headers || {};
          const target = header(headers, 'x-original-topic');
          const poison = header(headers, 'x-dlq-reason') === 'poison';
          if (target && (includePoison || !poison)) {
            // Drop our routing headers (x-attempt, x-error…): start fresh.
            const original = Object.fromEntries(
              Object.entries(headers).filter(([k]) => !k.startsWith('x-')),
            );
            await producer.send({
              topic: target,
              messages: [
                { key: message.key, value: message.value, headers: original },
              ],
            });
            replayed++;
          } else {
            skipped++;
          }
          await consumer.commitOffsets([
            {
              topic: dlq,
              partition,
              offset: (BigInt(message.offset) + 1n).toString(),
            },
          ]);
          if (++seen === pending) resolve();
        },
      })
      .catch(reject);
  });

  await consumer.disconnect();
  await producer.disconnect();
  console.log(
    `Replayed ${replayed} message(s) from ${dlq}` +
      (skipped ? `, skipped ${skipped} poison (use --include-poison)` : ''),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
