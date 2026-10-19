import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, Env, RedisModule, postgresSsl } from '@app/common';
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
import { FlashGateClient } from './flash/flash-gate.client';
import { IdempotencyService } from './idempotency/idempotency.service';
import { JobsModule } from './jobs/jobs.module';
import { CheckoutService } from './orders/checkout.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { OrderActionsService } from './orders/order-actions.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { OrderReadModelConsumer } from './read-model/order-read-model.consumer';
import { OrderViewProjector } from './read-model/order-view.projector';
import { SagaEventsConsumer } from './saga/saga-events.consumer';
import { OrderSagaService } from './saga/order-saga.service';
import { InvoicesService } from './invoices/invoices.service';
import { InternalPurchasesController } from './orders/internal-purchases.controller';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'order' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        ssl: postgresSsl(), // TLS to RDS on Stage 2 (off locally)
        entities: ORDER_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(ORDER_ENTITIES), // coupons, orders, outbox
    KafkaModule.forRoot(), // outbox writer + relay to Kafka
    RedisModule, // carts
    ProductClientModule, // live prices over gRPC
    ScheduleModule.forRoot(), // cron registry for the scheduled jobs
    JobsModule,
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
  controllers: [
    InternalPurchasesController, // product asks: did this user get it? (P5)
    CartController,
    CouponsController,
    OrdersController,
    AdminOrdersController,
  ],
  providers: [
    OrderActionsService,
    CartService,
    CartRepository,
    CatalogClient,
    CouponsService,
    OrderHistoryService,
    CheckoutService,
    FlashGateClient,
    OrdersService,
    IdempotencyService,
    OrderSagaService,
    SagaEventsConsumer,
    OrderViewProjector,
    OrderReadModelConsumer,
    InvoicesService, // GST invoice PDFs (Phase 2 P4)
  ],
})
export class OrderModule {}
