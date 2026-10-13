import {
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import {
  PRODUCT_CLIENT,
  PRODUCT_SERVICE_NAME,
  Product,
  ProductServiceClient,
} from '@app/proto';
import { toHttpError } from '../grpc/grpc-errors';
import { ListProductsQuery } from './list-products.query';

const DEADLINE_MS = 2000;

// Public JSON shape: attributes as an object, not the wire format's string.
const toJson = ({ attributesJson, ...product }: Product) => ({
  ...product,
  attributes: JSON.parse(attributesJson || '{}') as Record<string, unknown>,
});

// Public reads: REST/JSON outside, gRPC to the product service inside.
// Admin writes are proxied over HTTP instead (see GatewayModule).
@Controller('v1/products')
export class ProductsController implements OnModuleInit {
  private products!: ProductServiceClient;

  constructor(@Inject(PRODUCT_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.products =
      this.client.getService<ProductServiceClient>(PRODUCT_SERVICE_NAME);
  }

  @Get()
  async list(@Req() req: Request, @Query() q: ListProductsQuery) {
    const res = await this.call(
      this.products.listProducts(
        {
          category: q.category ?? '',
          minPrice: q.minPrice,
          maxPrice: q.maxPrice,
          q: q.q ?? '',
          cursor: q.cursor ?? '',
          limit: q.limit,
        },
        this.metadata(req),
      ),
    );
    return { items: res.items.map(toJson), nextCursor: res.nextCursor || null };
  }

  @Get(':idOrSlug')
  async get(@Req() req: Request, @Param('idOrSlug') idOrSlug: string) {
    return toJson(
      await this.call(
        this.products.getProduct({ idOrSlug }, this.metadata(req)),
      ),
    );
  }

  // Pass the correlation id on, so both services log the same id.
  private metadata(req: Request) {
    const metadata = new Metadata();
    const id = req.headers['x-correlation-id'];
    if (typeof id === 'string') metadata.set('x-correlation-id', id);
    return metadata;
  }

  // Every call gets a deadline and a clean HTTP error.
  private async call<T>(call: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(call.pipe(timeout(DEADLINE_MS)));
    } catch (err) {
      throw toHttpError('Product service', err);
    }
  }
}
