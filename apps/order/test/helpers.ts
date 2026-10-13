import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp, JWT_AUDIENCE, JWT_ISSUER } from '@app/common';
import type { Product } from '@app/proto';
import { orderAppOptions } from '../src/app.setup';
import { CatalogClient } from '../src/catalog/catalog.client';
import { OrderModule } from '../src/order.module';

// Shared by the order e2e suites. The containers and env come from
// e2e-setup.ts; each suite builds its own app with startOrderApp().

/** A valid 24-hex Mongo id from a number. */
export const oid = (n: number) => n.toString(16).padStart(24, '0');

export const product = (
  id: string,
  name: string,
  category: string,
  pricePaise: number,
) => ({ id, name, category, pricePaise }) as Product;

/** Stands in for the product service, so the suites don't need it running. */
export class FakeCatalog {
  down = false;
  readonly products = new Map<string, Product>();

  set(...products: Product[]) {
    products.forEach((p) => this.products.set(p.id, p));
  }

  getByIds(ids: string[]) {
    if (this.down) {
      return Promise.reject(
        new ServiceUnavailableException('Product service unavailable'),
      );
    }
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const p = this.products.get(id);
          return p ? [[id, p] as const] : [];
        }),
      ),
    );
  }
}

/** The real order service, with only the product service faked. */
export async function startOrderApp() {
  const signer = new JwtService({
    privateKey: readFileSync(process.env.E2E_JWT_PRIVATE_KEY_PATH!),
    signOptions: {
      algorithm: 'RS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '5m',
    },
  });

  const catalog = new FakeCatalog();
  const moduleRef = await Test.createTestingModule({ imports: [OrderModule] })
    .overrideProvider(CatalogClient)
    .useValue(catalog)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app, orderAppOptions); // same setup as main.ts
  // Listen once on a free port. Otherwise supertest starts the server for
  // every request, which parallel requests would overdo.
  await app.listen(0, '127.0.0.1');

  return {
    app,
    catalog,
    http: () => request(app.getHttpServer()),
    bearer: (sub: string, role = 'customer') =>
      `Bearer ${signer.sign({ sub, email: `${sub}@test.dev`, role })}`,
  };
}
