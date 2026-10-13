import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { CommonModule, Env, RedisModule } from '@app/common';
import { ProductClientModule } from '@app/proto';
import { CartController } from './cart/cart.controller';
import { CartRepository } from './cart/cart.repository';
import { CartService } from './cart/cart.service';
import { CatalogClient } from './catalog/catalog.client';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'order' }),
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
  controllers: [CartController],
  providers: [CartService, CartRepository, CatalogClient],
})
export class OrderModule {}
