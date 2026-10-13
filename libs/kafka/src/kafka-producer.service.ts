import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  type Kafka,
  Partitioners,
  type Producer,
  type TopicMessages,
} from 'kafkajs';
import { KAFKA_CLIENT } from './kafka.constants';

@Injectable()
export class KafkaProducerService implements OnModuleDestroy {
  private readonly producer: Producer;
  private connecting?: Promise<void>;

  constructor(@Inject(KAFKA_CLIENT) kafka: Kafka) {
    this.producer = kafka.producer({
      idempotent: true, // the broker drops copies caused by producer retries
      maxInFlightRequests: 1, // keeps per-partition order across retries
      allowAutoTopicCreation: false, // topics come from scripts/kafka-topics.js
      // Murmur2, the same as the Java client, so a key maps to the same
      // partition whichever client produced it.
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  /**
   * Connects on first use, so the service starts even while Kafka is down
   * (orders still work: their events wait in the outbox).
   */
  connect(): Promise<void> {
    this.connecting ??= this.producer.connect().catch((err: unknown) => {
      this.connecting = undefined; // try again next time
      throw err;
    });
    return this.connecting;
  }

  async sendBatch(topicMessages: TopicMessages[]): Promise<void> {
    await this.connect();
    // acks=all: confirmed only once every in-sync replica has the message.
    await this.producer.sendBatch({ topicMessages, acks: -1 });
  }

  async onModuleDestroy() {
    if (this.connecting) {
      await this.producer.disconnect().catch(() => undefined);
    }
  }
}
