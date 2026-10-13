import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { CommonModule, Env } from '@app/common';
import { Product, ProductSchema } from './products/product.schema';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'product' }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.getOrThrow('MONGO_URL', { infer: true }),
        maxPoolSize: 10,
        // Build indexes on startup outside production; there they should be
        // created deliberately, since building them can lock a big collection.
        autoIndex: config.get('NODE_ENV', { infer: true }) !== 'production',
      }),
    }),
    MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }]),
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
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductModule {}
