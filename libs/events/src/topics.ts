// One topic per aggregate, not per event type: all events of one order share
// the key orderId, so they land on the same partition and stay in order.
// Keep in sync with scripts/kafka-topics.js.
export const Topics = {
  ORDER_EVENTS: 'order-events',
  INVENTORY_EVENTS: 'inventory-events',
  PAYMENT_EVENTS: 'payment-events',
} as const;

const PREFIX_TO_TOPIC: Record<string, string> = {
  order: Topics.ORDER_EVENTS,
  stock: Topics.INVENTORY_EVENTS,
  payment: Topics.PAYMENT_EVENTS,
};

/** 'order.created' → 'order-events'. Throws for an unknown prefix. */
export function topicForEvent(type: string): string {
  const topic = PREFIX_TO_TOPIC[type.split('.')[0]];
  if (!topic) throw new Error(`No Kafka topic for event type "${type}"`);
  return topic;
}

// Each consumer group also has <group>.retry and <group>.dlq (BaseConsumer).
export const CONSUMER_GROUPS = [
  'inventory-svc',
  'order-svc',
  'payment-svc',
  'notification-svc',
] as const;

/** Every topic the system uses; the tests create these in their Kafka. */
export const ALL_TOPICS: string[] = [
  ...Object.values(Topics),
  ...CONSUMER_GROUPS.flatMap((g) => [`${g}.retry`, `${g}.dlq`]),
];
