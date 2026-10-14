import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { BootstrapOptions, Env } from '@app/common';
import {
  grpcLoaderOptions,
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PROTO_PATH,
} from '@app/proto';

// Shared by main.ts and the integration tests, so both run the same setup.

/** Adds the gRPC server (internal reads) next to the HTTP app. */
export function connectProductGrpc(app: INestApplication, url: string) {
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: PRODUCT_PACKAGE_NAME,
      protoPath: PRODUCT_PROTO_PATH,
      url,
      loader: grpcLoaderOptions,
    },
  });
}

// Hybrid app: HTTP on PORT (admin writes + health), gRPC on GRPC_PORT.
export const productAppOptions: BootstrapOptions = {
  globalPrefix: 'v1',
  swagger: { title: 'Products (admin)' },
  beforeListen: async (app) => {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const grpcPort = config.get('GRPC_PORT', { infer: true }) ?? 50052;
    connectProductGrpc(app, `0.0.0.0:${grpcPort}`);
    await app.startAllMicroservices();
  },
};
