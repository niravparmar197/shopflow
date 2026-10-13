import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, Env, RedisModule } from '@app/common';
import { KafkaModule } from '@app/kafka';
import { ProductClientModule } from '@app/proto';
import { CartController } from './cart/cart.controller';
import { CartRepository } from './cart/cart.repository';
import { CartService } from './cart/cart.service';
import { CatalogClient } from './catalog/catalog.client';
import { CouponsController } from './coupons/coupons.controller';
import { CouponsService } from './coupons/coupons.service';
import { OrderHistoryService } from './coupons/order-history.service';
import { ORDER_ENTITIES } from './database/entities';
import { IdempotencyService } from './idempotency/idempotency.service';
import { CheckoutService } from './orders/checkout.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { InventoryEventsConsumer } from './saga/inventory-events.consumer';
import { OrderSagaService } from './saga/order-saga.service';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'order' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        entities: ORDER_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(ORDER_ENTITIES), // coupons, orders, outbox
    KafkaModule.forRoot(), // outbox writer + relay to Kafka
    RedisModule, // carts
    ProductClientModule, // live prices over gRPC
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
  controllers: [CartController, CouponsController, OrdersController],
  providers: [
    CartService,
    CartRepository,
    CatalogClient,
    CouponsService,
    OrderHistoryService,
    CheckoutService,
    OrdersService,
    IdempotencyService,
    OrderSagaService,
    InventoryEventsConsumer,
  ],
})
export class OrderModule {}
