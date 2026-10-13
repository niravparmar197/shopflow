import { readFileSync } from 'node:fs';
import {
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import type Redis from 'ioredis';
import { CommonModule, Env, REDIS, RedisModule } from '@app/common';
import {
  grpcLoaderOptions,
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PROTO_PATH,
} from '@app/proto';
import { jwtMiddleware } from './http/jwt.middleware';
import { proxyTo } from './http/proxy';
import { createRateLimiter } from './http/rate-limit';
import {
  PRODUCT_CLIENT,
  ProductsController,
} from './products/products.controller';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'gateway' }),
    RedisModule,
    // Public key only: the gateway can check tokens but never create them.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        publicKey: readFileSync(
          config.getOrThrow('JWT_PUBLIC_KEY_PATH', { infer: true }),
        ),
      }),
    }),
    // gRPC client for the product service (public reads).
    ClientsModule.registerAsync([
      {
        name: PRODUCT_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => {
          const url: string = config.getOrThrow('PRODUCT_GRPC_URL', {
            infer: true,
          });
          return {
            transport: Transport.GRPC,
            options: {
              package: PRODUCT_PACKAGE_NAME,
              protoPath: PRODUCT_PROTO_PATH,
              url,
              loader: grpcLoaderOptions,
            },
          };
        },
      },
    ]),
  ],
  controllers: [ProductsController],
})
export class GatewayModule implements NestModule {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // Registered as Nest middleware (not app.use) so it runs after the
  // request logger, which assigns the correlation id.
  configure(consumer: MiddlewareConsumer) {
    const userService = this.config.getOrThrow('USER_SERVICE_URL', {
      infer: true,
    });
    const productService = this.config.getOrThrow('PRODUCT_SERVICE_URL', {
      infer: true,
    });

    // 1) Global limit for everything except health probes.
    consumer
      .apply(
        createRateLimiter(this.redis, {
          prefix: 'rl:global',
          points: 100,
          durationSec: 60,
          message: 'Too many requests',
        }),
      )
      .exclude('health/{*path}')
      .forRoutes('{*path}');

    // 2) Stricter limit on login against password guessing.
    consumer
      .apply(
        createRateLimiter(this.redis, {
          prefix: 'rl:login',
          points: 5,
          durationSec: 60,
          message: 'Too many login attempts, try again later',
        }),
      )
      .forRoutes({ path: 'v1/auth/login', method: RequestMethod.POST });

    // 3) Protected routes: JWT first, then proxy.
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(userService))
      .forRoutes('v1/users{/*path}');

    // 4) Public auth routes: proxy only.
    consumer.apply(proxyTo(userService)).forRoutes('v1/auth{/*path}');

    // 5) Admin product writes: JWT here, then HTTP proxy. The product service
    //    checks the admin role itself. Reads go over gRPC (ProductsController).
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(productService))
      .forRoutes(
        { path: 'v1/products', method: RequestMethod.POST },
        { path: 'v1/products/:id', method: RequestMethod.PATCH },
      );
  }
}
