import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout } from 'rxjs';
import {
  PRODUCT_CLIENT,
  PRODUCT_SERVICE_NAME,
  Product,
  ProductServiceClient,
} from '@app/proto';

const DEADLINE_MS = 1000;

/** Reads live product data (names, prices) from the product service. */
@Injectable()
export class CatalogClient implements OnModuleInit {
  private readonly logger = new Logger(CatalogClient.name);
  private products!: ProductServiceClient;

  constructor(@Inject(PRODUCT_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.products =
      this.client.getService<ProductServiceClient>(PRODUCT_SERVICE_NAME);
  }

  /**
   * Active products by id. Missing or inactive ids are simply absent from the
   * map. Throws 503 if the product service fails or misses the deadline.
   */
  async getByIds(
    ids: string[],
    correlationId?: string,
  ): Promise<Map<string, Product>> {
    if (!ids.length) return new Map();
    const metadata = new Metadata();
    if (correlationId) metadata.set('x-correlation-id', correlationId);

    try {
      const res = await firstValueFrom(
        this.products
          .getProductsByIds({ ids }, metadata)
          .pipe(timeout(DEADLINE_MS)),
      );
      return new Map(res.items.map((p) => [p.id, p]));
    } catch (err: unknown) {
      this.logger.warn({ err, ids }, 'Product service call failed');
      throw new ServiceUnavailableException('Product service unavailable');
    }
  }
}
