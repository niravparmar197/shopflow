import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import type { Env } from '@app/common';
import { KAFKA_CLIENT } from './kafka.constants';
import { KafkaProducerService } from './kafka-producer.service';
import { OutboxRelay } from './outbox/outbox-relay.service';
import { OutboxService } from './outbox/outbox.service';

export interface KafkaModuleOptions {
  /**
   * The transactional outbox (writer + relay). Needs TypeORM with the
   * OutboxEvent entity and the outbox table in the service's migrations.
   * Off for services without Postgres (notification): they only consume,
   * and use the producer for the retry and DLQ topics. Default true.
   */
  outbox?: boolean;
}

/** Kafka client, producer and (by default) the transactional outbox. */
@Module({})
export class KafkaModule {
  static forRoot({ outbox = true }: KafkaModuleOptions = {}): DynamicModule {
    return {
      module: KafkaModule,
      global: true,
      providers: [
        {
          provide: KAFKA_CLIENT,
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) =>
            new Kafka({
              clientId: config.get('SERVICE_NAME', { infer: true }),
              brokers: config
                .getOrThrow('KAFKA_BROKERS', { infer: true })
                .split(','),
              logLevel: logLevel.WARN,
              retry: { retries: 5 },
            }),
        },
        KafkaProducerService,
        ...(outbox ? [OutboxService, OutboxRelay] : []),
      ],
      exports: [
        KAFKA_CLIENT,
        KafkaProducerService,
        ...(outbox ? [OutboxService] : []),
      ],
    };
  }
}
