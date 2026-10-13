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
import type Redis from 'ioredis';
import {
  type AuthenticatedRequest,
  CommonModule,
  Env,
  REDIS,
  RedisModule,
} from '@app/common';
import { ProductClientModule } from '@app/proto';
import { jwtMiddleware } from './http/jwt.middleware';
import { proxyTo } from './http/proxy';
import { createRateLimiter } from './http/rate-limit';
import { userRateLimit } from './http/user-rate-limit';
import { ProductsController } from './products/products.controller';

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
    ProductClientModule,
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
    const orderService = this.config.getOrThrow('ORDER_SERVICE_URL', {
      infer: true,
    });
    const inventoryService = this.config.getOrThrow('INVENTORY_SERVICE_URL', {
      infer: true,
    });
    const paymentService = this.config.getOrThrow('PAYMENT_SERVICE_URL', {
      infer: true,
    });
    const notificationService = this.config.getOrThrow(
      'NOTIFICATION_SERVICE_URL',
      { infer: true },
    );

    // Exact per-user limits on expensive WRITES (sliding window, after the
    // JWT check). Invisible to a real user (idempotency absorbs double
    // clicks), painful for a buy-script. Layers: global per IP (1), login
    // per IP (2), these, and the bulkhead in the order service (F9 part 2).
    const ordersLimit = userRateLimit(this.redis, {
      name: 'orders',
      limit: 5,
      windowMs: 10_000,
    });
    const cartLimit = userRateLimit(this.redis, {
      name: 'cart',
      limit: 30,
      windowMs: 10_000,
      methods: ['POST', 'PATCH', 'DELETE'],
    });
    const paymentsLimit = userRateLimit(this.redis, {
      name: 'checkout',
      limit: 5,
      windowMs: 10_000,
    });

    // Provider webhooks: many requests from a few IPs. A 429 would make the
    // provider retry for hours, so they skip the per-IP limit.
    const webhooks = {
      path: 'v1/payments/webhooks/:provider',
      method: RequestMethod.POST,
    };

    // 1) Global limit per IP for everything except health probes and
    //    webhooks (100/min unless RATE_LIMIT_GLOBAL_PER_MIN says otherwise).
    consumer
      .apply(
        createRateLimiter(this.redis, {
          prefix: 'rl:global',
          points: this.config.get('RATE_LIMIT_GLOBAL_PER_MIN', { infer: true }),
          durationSec: 60,
          message: 'Too many requests',
        }),
      )
      .exclude('health/{*path}', webhooks)
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
    consumer.apply(jwtMiddleware(this.jwt), proxyTo(productService)).forRoutes(
      { path: 'v1/products', method: RequestMethod.POST },
      { path: 'v1/products/:id', method: RequestMethod.PATCH },
      {
        path: 'v1/products/:id/images/upload-url',
        method: RequestMethod.POST,
      },
      { path: 'v1/products/:id/images/confirm', method: RequestMethod.POST },
    );

    // 6) Cart and coupons: JWT here, then proxy. The order service checks it
    //    again, takes the user id only from the token, and checks the admin
    //    role for coupon management. Cart writes get a per-user limit.
    consumer
      .apply(jwtMiddleware(this.jwt), cartLimit, proxyTo(orderService))
      .forRoutes('v1/cart{/*path}');
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(orderService))
      .forRoutes('v1/coupons{/*path}');

    // 7) Orders. Placing one is expensive (gRPC, a transaction), so it gets
    //    per-user limits, counted after the JWT check: ≤ 5 per 10 s exactly
    //    (bursts) and ≤ 10 per minute (sustained).
    const placeOrder = { path: 'v1/orders', method: RequestMethod.POST };
    consumer
      .apply(
        jwtMiddleware(this.jwt),
        ordersLimit,
        createRateLimiter(this.redis, {
          prefix: 'rl:order',
          points: 10,
          durationSec: 60,
          message: 'Too many orders, try again later',
          key: (req) => (req as AuthenticatedRequest).user.sub,
        }),
        proxyTo(orderService),
      )
      .forRoutes(placeOrder);
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(orderService))
      .exclude(placeOrder)
      .forRoutes('v1/orders{/*path}');

    // 8) Inventory (admin stock management): JWT here, the inventory
    //    service checks the admin role.
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(inventoryService))
      .forRoutes('v1/inventory{/*path}');

    // 9) Payment webhooks: NO JWT (the provider has no user token); the
    //    HMAC signature is the auth. The gateway has no body parser, so the
    //    raw bytes reach the payment service unchanged.
    consumer.apply(proxyTo(paymentService)).forRoutes(webhooks);

    // 10) Payments: JWT here; the payment service checks it again and only
    //     shows the caller's own payments. 10 s timeout: checkout retries
    //     the provider for up to ~6.6 s (3 × 2 s + backoff). POSTs (checkout)
    //     get a per-user limit; the webhooks above don't.
    consumer
      .apply(
        jwtMiddleware(this.jwt),
        paymentsLimit,
        proxyTo(paymentService, 10_000),
      )
      .exclude(webhooks)
      .forRoutes('v1/payments{/*path}');

    // 11) Notification logs (support): JWT here; the notification service
    //     checks the admin role.
    consumer
      .apply(jwtMiddleware(this.jwt), proxyTo(notificationService))
      .forRoutes('v1/notifications{/*path}');
  }
}
