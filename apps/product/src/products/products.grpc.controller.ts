import { Controller, Logger, UseFilters } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { GrpcExceptionFilter } from '@app/common';
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

// Mongo document → protobuf message.
const toMessage = (p: StoredProduct): ProductMessage => ({
  id: String(p._id),
  name: p.name,
  slug: p.slug,
  description: p.description ?? '',
  category: p.category,
  pricePaise: p.pricePaise,
  currency: p.currency,
  images: p.images ?? [],
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

  constructor(private readonly products: ProductsService) {}

  async getProduct(req: GetProductRequest, metadata?: Metadata) {
    this.logCall('GetProduct', metadata);
    return toMessage(await this.products.findOne(req.idOrSlug));
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
      items: res.items.map(toMessage),
      nextCursor: res.nextCursor ?? '',
    };
  }

  async getProductsByIds(req: GetProductsByIdsRequest, metadata?: Metadata) {
    this.logCall('GetProductsByIds', metadata);
    const items = await this.products.findByIds(req.ids);
    return { items: items.map(toMessage) };
  }

  private logCall(method: string, metadata?: Metadata) {
    const correlationId = metadata?.get('x-correlation-id')[0] ?? 'none';
    this.logger.log(
      { method, correlationId: String(correlationId) },
      'gRPC call',
    );
  }
}
