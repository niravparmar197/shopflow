import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import type { Env } from '@app/common';
import { PRODUCT_PACKAGE_NAME } from './generated/product';
import { grpcLoaderOptions, PRODUCT_PROTO_PATH } from './grpc-options';

export const PRODUCT_CLIENT = Symbol('PRODUCT_CLIENT');

/**
 * gRPC client for the product service, injected with
 * @Inject(PRODUCT_CLIENT). Shared by every service that reads the catalog.
 */
@Module({
  imports: [
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
  exports: [ClientsModule],
})
export class ProductClientModule {}
