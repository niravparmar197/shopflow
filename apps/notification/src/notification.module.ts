import { readFileSync } from 'node:fs';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
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
    // Public key only: checks tokens for the admin log endpoint.
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        publicKey: readFileSync(
          config.getOrThrow('JWT_PUBLIC_KEY_PATH', { infer: true }),
        ),
      }),
    }),
    NotificationsModule,
  ],
})
export class NotificationModule {}
