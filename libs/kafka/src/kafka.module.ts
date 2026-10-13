import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import type { Env } from '@app/common';
import { KAFKA_CLIENT } from './kafka.constants';
import { KafkaProducerService } from './kafka-producer.service';
import { OutboxRelay } from './outbox/outbox-relay.service';
import { OutboxService } from './outbox/outbox.service';

/**
 * Kafka client, producer and the transactional outbox (writer + relay).
 * The service must register OutboxEvent with TypeORM and have the outbox
 * table in its migrations.
 */
@Module({})
export class KafkaModule {
  static forRoot(): DynamicModule {
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
        OutboxService,
        OutboxRelay,
      ],
      exports: [KAFKA_CLIENT, KafkaProducerService, OutboxService],
    };
  }
}
