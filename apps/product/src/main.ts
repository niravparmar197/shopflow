import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { bootstrapService, Env } from '@app/common';
import {
  grpcLoaderOptions,
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PROTO_PATH,
} from '@app/proto';
import { ProductModule } from './product.module';

// Hybrid app: HTTP on PORT (admin writes + health), gRPC on GRPC_PORT
// (internal reads for the gateway and other services).
void bootstrapService(ProductModule, {
  globalPrefix: 'v1',
  beforeListen: async (app) => {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const grpcPort = config.get('GRPC_PORT', { infer: true }) ?? 50052;
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: PRODUCT_PACKAGE_NAME,
        protoPath: PRODUCT_PROTO_PATH,
        url: `0.0.0.0:${grpcPort}`,
        loader: grpcLoaderOptions,
      },
    });
    await app.startAllMicroservices();
  },
});
