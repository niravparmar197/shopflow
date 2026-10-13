import { Controller, Logger, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Metadata } from '@grpc/grpc-js';
import { Env, GrpcExceptionFilter } from '@app/common';
import {
  GetProductRequest,
  GetProductsByIdsRequest,
  ListProductsRequest,
  Product as ProductMessage,
  ProductServiceController,
  ProductServiceControllerMethods,
} from '@app/proto';
import { Product } from './product.schema';
import { ProductsService } from './products.service';

type StoredProduct = Product & { _id: unknown };

// Mongo document → protobuf message. Images are stored as keys and sent as
// URLs, so moving from MinIO to a CDN needs no data change.
const toMessage = (p: StoredProduct, assetBase: string): ProductMessage => ({
  id: String(p._id),
  name: p.name,
  slug: p.slug,
  description: p.description ?? '',
  category: p.category,
  pricePaise: p.pricePaise,
  currency: p.currency,
  images: (p.images ?? []).map((key) => `${assetBase}/${key}`),
  version: p.version ?? 0,
  createdAt: new Date(p.createdAt).toISOString(),
  attributesJson: JSON.stringify(p.attributes ?? {}),
});

// Internal API for other services (the gateway, later order). No auth here:
// the gRPC port is not exposed publicly; only reads are offered.
@Controller()
@UseFilters(GrpcExceptionFilter)
@ProductServiceControllerMethods()
export class ProductsGrpcController implements ProductServiceController {
  private readonly logger = new Logger(ProductsGrpcController.name);
  private readonly assetBase: string;

  constructor(
    private readonly products: ProductsService,
    config: ConfigService<Env, true>,
  ) {
    this.assetBase = config
      .getOrThrow('ASSET_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  private toMessage(p: StoredProduct) {
    return toMessage(p, this.assetBase);
  }

  async getProduct(req: GetProductRequest, metadata?: Metadata) {
    this.logCall('GetProduct', metadata);
    return this.toMessage(await this.products.findOne(req.idOrSlug));
  }

  async listProducts(req: ListProductsRequest, metadata?: Metadata) {
    this.logCall('ListProducts', metadata);
    const res = await this.products.list({
      category: req.category || undefined,
      minPrice: req.minPrice ?? undefined,
      maxPrice: req.maxPrice ?? undefined,
      q: req.q || undefined,
      cursor: req.cursor || undefined,
      limit: req.limit, // clamped by the service
    });
    return {
      items: res.items.map((p) => this.toMessage(p)),
      nextCursor: res.nextCursor ?? '',
    };
  }

  async getProductsByIds(req: GetProductsByIdsRequest, metadata?: Metadata) {
    this.logCall('GetProductsByIds', metadata);
    const items = await this.products.findByIds(req.ids);
    return { items: items.map((p) => this.toMessage(p)) };
  }

  private logCall(method: string, metadata?: Metadata) {
    const correlationId = metadata?.get('x-correlation-id')[0] ?? 'none';
    this.logger.log(
      { method, correlationId: String(correlationId) },
      'gRPC call',
    );
  }
}
