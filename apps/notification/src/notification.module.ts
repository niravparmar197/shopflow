import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CommonModule, type Env } from '@app/common';
import { KafkaModule } from '@app/kafka';
import { NotificationsModule } from './notifications.module';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'notification' }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.getOrThrow('MONGO_URL', { infer: true }),
        maxPoolSize: 10,
        // Build indexes on startup outside production (as in product).
        autoIndex: config.get('NODE_ENV', { infer: true }) !== 'production',
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.getOrThrow('REDIS_URL', { infer: true }));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
            maxRetriesPerRequest: null, // required by BullMQ workers
          },
        };
      },
    }),
    // Producer for the retry/DLQ topics only: no outbox (no Postgres here).
    KafkaModule.forRoot({ outbox: false }),
    NotificationsModule,
  ],
})
export class NotificationModule {}
