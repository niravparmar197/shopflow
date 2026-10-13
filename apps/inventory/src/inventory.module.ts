import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, Env } from '@app/common';
import { KafkaModule } from '@app/kafka';
import { INVENTORY_ENTITIES } from './database/entities';
import { OrderEventsConsumer } from './reservations/order-events.consumer';
import { ReservationService } from './reservations/reservation.service';
import { StockController } from './stock/stock.controller';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'inventory' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        entities: INVENTORY_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(INVENTORY_ENTITIES),
    KafkaModule.forRoot(), // outbox writer + relay; consumers use its client
    // Public key only: this service checks tokens but never creates them.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        publicKey: readFileSync(
          config.getOrThrow('JWT_PUBLIC_KEY_PATH', { infer: true }),
        ),
      }),
    }),
  ],
  controllers: [StockController],
  providers: [ReservationService, OrderEventsConsumer],
})
export class InventoryModule {}
