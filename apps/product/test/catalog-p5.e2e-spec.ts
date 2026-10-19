import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Model } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp, JWT_AUDIENCE, JWT_ISSUER } from '@app/common';
import { productAppOptions } from '../src/app.setup';
import { ProductModule } from '../src/product.module';
import { Product } from '../src/products/product.schema';
import { ProductsService } from '../src/products/products.service';
import { PurchaseCheckClient } from '../src/reviews/purchase-check.client';
import { Review } from '../src/reviews/review.schema';

/** Who received what: "userId:productId". Stands in for the order service. */
class FakePurchases {
  delivered = new Set<string>();
  down = false;
  hasReceived(userId: string, productId: string) {
    if (this.down) {
      return Promise.reject(
        new ServiceUnavailableException({
          code: 'PURCHASE_CHECK_UNAVAILABLE',
          message: 'down',
        }),
      );
    }
    return Promise.resolve(this.delivered.has(`${userId}:${productId}`));
  }
}

// Phase 2 P5: sorting, categories, reviews + ratings.
describe('Catalog P5 (e2e)', () => {
  let app: INestApplication<App>;
  let products: Model<Product>;
  let reviews: Model<Review>;
  let signer: JwtService;
  const purchases = new FakePurchases();
  const http = () => request(app.getHttpServer());
  const bearer = (sub: string) =>
    `Bearer ${signer.sign({ sub, email: `${sub}@t.dev`, role: 'customer' })}`;
  let phoneId = '';

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
    })
      .overrideProvider(PurchaseCheckClient)
      .useValue(purchases)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, productAppOptions);
    await app.init();

    products = app.get(getModelToken(Product.name));
    reviews = app.get(getModelToken(Review.name));
    await products.deleteMany({});
    await reviews.deleteMany({});
    await products.syncIndexes();
    await reviews.syncIndexes();
    // Prices repeat on purpose (ties): the _id tie-breaker must hold.
    const prices = [500, 300, 300, 900, 100, 300, 700];
    await products.insertMany(
      prices.map((p, i) => ({
        name: `P${i}`,
        slug: `p5-item-${i}`,
        category: i < 4 ? 'phones' : 'shoes',
        pricePaise: p * 100,
      })),
    );
    await products.create({
      name: 'Hidden',
      slug: 'p5-hidden',
      category: 'toys',
      pricePaise: 1,
      isActive: false,
    });
    phoneId = String((await products.findOne({ slug: 'p5-item-0' }))!._id);
  });

  afterAll(async () => {
    // Leave the shared test database as we found it (other suites count rows).
    await products?.deleteMany({ slug: /^p5-/ });
    await reviews?.deleteMany({});
    await app?.close();
  });

  /** Every item, page by page, in the given sort. */
  async function walk(sort: string, limit = 2) {
    const seen: number[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const res = await http()
        .get(
          `/v1/products?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        )
        .expect(200);
      seen.push(
        ...res.body.items.map(
          (p: { pricePaise: number }) => p.pricePaise / 100,
        ),
      );
      cursor = res.body.nextCursor;
    }
    return seen;
  }

  describe('sorting', () => {
    it('price low to high and high to low, across pages, ties included', async () => {
      expect(await walk('price_asc')).toEqual([
        100, 300, 300, 300, 500, 700, 900,
      ]);
      expect(await walk('price_desc')).toEqual([
        900, 700, 500, 300, 300, 300, 100,
      ]);
    });

    it("a cursor from one sort can't be used with another", async () => {
      const first = await http()
        .get('/v1/products?sort=price_asc&limit=2')
        .expect(200);
      const res = await http()
        .get(`/v1/products?sort=price_desc&cursor=${first.body.nextCursor}`)
        .expect(400);
      expect(res.body.message).toBe('Invalid cursor');
      await http().get('/v1/products?sort=cheapest').expect(400);
    });
  });

  it('categories: only active products, counted, A to Z', async () => {
    const svc = app.get(ProductsService);
    expect(await svc.categories()).toEqual([
      { slug: 'phones', count: 4 },
      { slug: 'shoes', count: 3 },
    ]);
  });

  describe('reviews', () => {
    const asha = randomUUID();
    const ravi = randomUUID();
    const body = (rating: number, extra: object = {}) => ({
      rating,
      title: 'Good phone',
      body: 'Battery lasts two days. Camera is fine.',
      authorName: 'Asha P.',
      ...extra,
    });
    const put = (user: string, b: object) =>
      http()
        .put(`/v1/products/${phoneId}/reviews`)
        .set('Authorization', bearer(user))
        .send(b);
    const rating = async () => {
      const p = (await products.findById(phoneId).lean())!;
      return { sum: p.ratingSum, count: p.ratingCount };
    };

    it('reading is public; writing needs a login and a delivered order', async () => {
      const list = await http()
        .get(`/v1/products/${phoneId}/reviews`)
        .expect(200);
      expect(list.body).toMatchObject({
        items: [],
        nextCursor: null,
        summary: { ratingAvg: 0, ratingCount: 0 },
      });

      await http()
        .put(`/v1/products/${phoneId}/reviews`)
        .send(body(5))
        .expect(401);
      const notBuyer = await put(asha, body(5)).expect(403);
      expect(notBuyer.body.code).toBe('NOT_A_BUYER');

      purchases.delivered.add(`${asha}:${phoneId}`);
      await put(asha, body(5, { body: 'short' })).expect(400);
      await put(asha, body(6)).expect(400);
      const ok = await put(asha, body(5)).expect(200);
      expect(ok.body).toMatchObject({
        rating: 5,
        verifiedPurchase: true,
        authorName: 'Asha P.',
      });
      expect(ok.body.userId).toBeUndefined(); // never shown
      expect(await rating()).toEqual({ sum: 5, count: 1 });
    });

    it('editing moves the average, not the count; the product shows it', async () => {
      await put(asha, body(3)).expect(200);
      expect(await rating()).toEqual({ sum: 3, count: 1 });

      purchases.delivered.add(`${ravi}:${phoneId}`);
      await put(ravi, body(4, { authorName: 'Ravi' })).expect(200);
      expect(await rating()).toEqual({ sum: 7, count: 2 });

      const p = await http().get(`/v1/products/${phoneId}`).expect(200);
      expect(p.body).toMatchObject({ ratingSum: 7, ratingCount: 2 });

      const list = await http()
        .get(`/v1/products/${phoneId}/reviews`)
        .expect(200);
      expect(
        list.body.items.map((r: { authorName: string }) => r.authorName),
      ).toEqual(['Ravi', 'Asha P.']); // newest first
      expect(list.body.summary).toEqual({
        ratingAvg: 3.5,
        ratingCount: 2,
        stars: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 },
      });
    });

    it('mine, delete, and paging', async () => {
      const mine = await http()
        .get(`/v1/products/${phoneId}/reviews/mine`)
        .set('Authorization', bearer(asha))
        .expect(200);
      expect(mine.body.rating).toBe(3);

      await http()
        .delete(`/v1/products/${phoneId}/reviews`)
        .set('Authorization', bearer(asha))
        .expect(204);
      expect(await rating()).toEqual({ sum: 4, count: 1 });
      await http()
        .delete(`/v1/products/${phoneId}/reviews`)
        .set('Authorization', bearer(asha))
        .expect(404);

      const page = await http()
        .get(`/v1/products/${phoneId}/reviews?limit=1`)
        .expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).toBeNull();
    });

    it('two first reviews from one buyer at once: one review, counted once', async () => {
      const u = randomUUID();
      purchases.delivered.add(`${u}:${phoneId}`);
      const before = await rating();
      const results = await Promise.all([put(u, body(5)), put(u, body(2))]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(
        await reviews.countDocuments({ productId: phoneId, userId: u }),
      ).toBe(1);
      const after = await rating();
      expect(after.count).toBe(before.count + 1);
      const saved = (await reviews
        .findOne({ productId: phoneId, userId: u })
        .lean())!;
      expect(after.sum).toBe(before.sum + saved.rating); // matches what won
    });

    it('order service down: 503, nothing saved', async () => {
      const u = randomUUID();
      purchases.down = true;
      try {
        const res = await put(u, body(5)).expect(503);
        expect(res.body.code).toBe('PURCHASE_CHECK_UNAVAILABLE');
      } finally {
        purchases.down = false;
      }
      expect(await reviews.countDocuments({ userId: u })).toBe(0);
    });

    it('unknown product: 404; not an id: 400', async () => {
      await http()
        .get('/v1/products/0123456789abcdef01234567/reviews')
        .expect(404);
      await http().get('/v1/products/nope/reviews').expect(400);
    });
  });
});
