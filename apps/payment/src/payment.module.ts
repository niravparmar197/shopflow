import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, Env, postgresSsl } from '@app/common';
import { KafkaModule } from '@app/kafka';
import { ResilienceModule } from '@app/resilience';
import { PAYMENT_ENTITIES } from './database/entities';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'payment' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        ssl: postgresSsl(), // TLS to RDS on Stage 2 (off locally)
        entities: PAYMENT_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    KafkaModule.forRoot(), // outbox writer + relay; consumers use its client
    // Public key only: this service checks tokens but never creates them.
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        publicKey: readFileSync(
          config.getOrThrow('JWT_PUBLIC_KEY_PATH', { infer: true }),
        ),
      }),
    }),
    ResilienceModule, // one circuit breaker per payment provider
    PaymentsModule,
  ],
})
export class PaymentModule {}
