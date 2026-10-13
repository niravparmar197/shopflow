import type { Options } from '@grpc/proto-loader';
import { join } from 'node:path';

// Services run from the repo root (they read keys/ and apps/*/.env the same way).
export const PRODUCT_PROTO_PATH = join(
  process.cwd(),
  'libs/proto/src/product.proto',
);

// How the .proto is loaded at runtime, on both the server and client side.
export const grpcLoaderOptions: Options = {
  keepCase: false, // price_paise → pricePaise, matching the generated types
  longs: Number, // int64 → plain number (paise amounts are far below 2^53)
  enums: String,
  defaults: true,
  oneofs: true,
};
