import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { readFileSync } from 'node:fs';
import type { Model } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp, JWT_AUDIENCE, JWT_ISSUER } from '@app/common';
import { grpcLoaderOptions, PRODUCT_PROTO_PATH } from '@app/proto';
import { connectProductGrpc, productAppOptions } from '../src/app.setup';
import { ProductModule } from '../src/product.module';
import { Product } from '../src/products/product.schema';

const GRPC_URL = '127.0.0.1:50599';
const CATEGORIES = ['phones', 'laptops', 'shoes', 'shirts', 'watches'];

type RpcCall = (
  req: object,
  cb: (err: grpc.ServiceError | null, res: any) => void,
) => void;

// Real product service (HTTP + gRPC) + real MongoDB + real Redis. The
// containers and env come from e2e-setup.ts.
describe('Products (e2e)', () => {
  let app: INestApplication<App>;
  let model: Model<Product>;
  let grpcClient: grpc.Client & Record<string, RpcCall>;
  let signer: JwtService;

  const http = () => request(app.getHttpServer());
  const bearer = (role: string) =>
    `Bearer ${signer.sign({ sub: 'u1', email: 'a@b.com', role })}`;
  const rpc = (method: string, req: object) =>
    new Promise<any>((resolve, reject) =>
      grpcClient[method](req, (err, res) => (err ? reject(err) : resolve(res))),
    );

  beforeAll(async () => {
    signer = new JwtService({
      privateKey: readFileSync(process.env.E2E_JWT_PRIVATE_KEY_PATH!),
      signOptions: {
        algorithm: 'RS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: '5m',
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ProductModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, productAppOptions); // same setup as main.ts
    connectProductGrpc(app, GRPC_URL);
    await app.startAllMicroservices();
    await app.init();

    model = app.get(getModelToken(Product.name));
    await model.syncIndexes();
    await model.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        name: `Item ${i}`,
        slug: `item-${i}`,
        category: CATEGORIES[i % CATEGORIES.length],
        pricePaise: (i + 1) * 10000,
      })),
    );

    // A plain gRPC client, as any other service would use it.
    const definition = protoLoader.loadSync(
      PRODUCT_PROTO_PATH,
      grpcLoaderOptions,
    );
    const pkg = grpc.loadPackageDefinition(definition).product as unknown as {
      ProductService: new (
        url: string,
        creds: grpc.ChannelCredentials,
      ) => typeof grpcClient;
    };
    grpcClient = new pkg.ProductService(
      GRPC_URL,
      grpc.credentials.createInsecure(),
    );
  });

  afterAll(async () => {
    grpcClient?.close();
    await app?.close();
  });

  describe('listing', () => {
    it('walks every page with the cursor: each item once, newest first', async () => {
      const seen: string[] = [];
      let cursor: string | null = '';
      let pages = 0;
      while (cursor !== null) {
        const res = await http()
          .get(`/v1/products?limit=7${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        seen.push(...res.body.items.map((p: { _id: string }) => p._id));
        cursor = res.body.nextCursor;
        pages++;
      }
      // insertMany gives the items (nearly) the same createdAt, so this also
      // proves the _id tie-breaker in the cursor.
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(pages).toBe(4); // 7 + 7 + 7 + 4
    });

    it('filters by category and price range', async () => {
      const res = await http()
        .get('/v1/products?category=Phones&minPrice=50000&maxPrice=200000')
        .expect(200);
      expect(
        res.body.items.map((p: { slug: string }) => p.slug).sort(),
      ).toEqual(['item-10', 'item-15', 'item-5']);
    });

    it('rejects a limit above 50 and a tampered cursor', async () => {
      await http().get('/v1/products?limit=1000').expect(400);
      const res = await http().get('/v1/products?cursor=abc').expect(400);
      expect(res.body.message).toBe('Invalid cursor');
    });
  });

  describe('admin writes', () => {
    it('create needs admin: 401 without token, 403 for customer, 201 for admin', async () => {
      const body = {
        name: 'New',
        slug: 'new-item',
        category: 'phones',
        pricePaise: 100,
      };
      await http().post('/v1/products').send(body).expect(401);
      await http()
        .post('/v1/products')
        .set('Authorization', bearer('customer'))
        .send(body)
        .expect(403);
      await http()
        .post('/v1/products')
        .set('Authorization', bearer('admin'))
        .send(body)
        .expect(201);
      await http()
        .post('/v1/products')
        .set('Authorization', bearer('admin'))
        .send(body)
        .expect(409); // duplicate slug
    });

    it('stale version gets 409, and the cached product shows the new price at once', async () => {
      const before = (await http().get('/v1/products/item-3').expect(200)).body;
      await http().get('/v1/products/item-3').expect(200); // now served from cache

      await http()
        .patch(`/v1/products/${before._id}`)
        .set('Authorization', bearer('admin'))
        .send({ pricePaise: 999, version: before.version })
        .expect(200);
      const stale = await http()
        .patch(`/v1/products/${before._id}`)
        .set('Authorization', bearer('admin'))
        .send({ pricePaise: 111, version: before.version })
        .expect(409);
      expect(stale.body.message).toMatch(/changed by someone else/);

      const after = (await http().get('/v1/products/item-3').expect(200)).body;
      expect(after.pricePaise).toBe(999);
      expect(after.version).toBe(before.version + 1);
    });

    it('lets only one of two simultaneous edits of the same version win', async () => {
      const p = (await http().get('/v1/products/item-4').expect(200)).body;
      const edit = (pricePaise: number) =>
        http()
          .patch(`/v1/products/${p._id}`)
          .set('Authorization', bearer('admin'))
          .send({ pricePaise, version: p.version });
      const results = await Promise.all([edit(1), edit(2)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('a slug rename makes the old slug 404 at once (no stale cache)', async () => {
      const p = (await http().get('/v1/products/item-6').expect(200)).body; // cached
      await http()
        .patch(`/v1/products/${p._id}`)
        .set('Authorization', bearer('admin'))
        .send({ slug: 'item-6-renamed', version: p.version })
        .expect(200);
      await http().get('/v1/products/item-6').expect(404);
      await http().get('/v1/products/item-6-renamed').expect(200);
    });

    it('a product created after a cached "not found" is visible at once', async () => {
      await http().get('/v1/products/late-item').expect(404); // caches "not found"
      await http()
        .post('/v1/products')
        .set('Authorization', bearer('admin'))
        .send({
          name: 'Late',
          slug: 'late-item',
          category: 'misc',
          pricePaise: 5,
        })
        .expect(201);
      await http().get('/v1/products/late-item').expect(200);
    });

    it('lists reflect a price change at once (list version bump)', async () => {
      const list = () =>
        http().get('/v1/products?category=laptops&limit=50').expect(200);
      const p = (await list()).body.items[0];
      await list(); // cached
      await http()
        .patch(`/v1/products/${p._id}`)
        .set('Authorization', bearer('admin'))
        .send({ pricePaise: 4242, version: p.version })
        .expect(200);
      const updated = (await list()).body.items.find(
        (x: { _id: string }) => x._id === p._id,
      );
      expect(updated.pricePaise).toBe(4242);
    });
  });

  describe('gRPC contract', () => {
    it('ListProducts returns proto-shaped items and a cursor', async () => {
      const res = await rpc('ListProducts', { limit: 5 });
      expect(res.items).toHaveLength(5);
      expect(typeof res.items[0].pricePaise).toBe('number'); // int64 → number
      expect(res.items[0].id).toMatch(/^[a-f0-9]{24}$/);
      expect(res.nextCursor).not.toBe('');
    });

    it('GetProduct returns NOT_FOUND for a missing product', async () => {
      await expect(
        rpc('GetProduct', { idOrSlug: 'nope' }),
      ).rejects.toMatchObject({
        code: grpc.status.NOT_FOUND,
      });
    });

    it('ListProducts returns INVALID_ARGUMENT for a tampered cursor', async () => {
      await expect(
        rpc('ListProducts', { cursor: 'garbage', limit: 5 }),
      ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    });

    it('GetProductsByIds returns only existing products', async () => {
      const one = await rpc('GetProduct', { idOrSlug: 'item-1' });
      const res = await rpc('GetProductsByIds', {
        ids: [one.id, 'f'.repeat(24), 'bad'],
      });
      expect(res.items.map((i: { id: string }) => i.id)).toEqual([one.id]);
    });

    it('returns image keys as full URLs and attributes as JSON', async () => {
      await model.updateOne(
        { slug: 'item-8' },
        { $set: { images: ['products/x/1.png'], attributes: { ram: '8GB' } } },
      );
      const res = await rpc('GetProduct', { idOrSlug: 'item-8' });
      expect(res.images).toEqual(['http://cdn.test/products/x/1.png']);
      expect(JSON.parse(res.attributesJson)).toEqual({ ram: '8GB' });
    });
  });
});
