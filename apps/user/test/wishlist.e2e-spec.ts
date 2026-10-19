import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { configureApp } from '@app/common';
import { userAppOptions } from '../src/app.setup';
import { UserModule } from '../src/user.module';

const P1 = 'a'.repeat(24);
const P2 = 'b'.repeat(24);

// Phase 2 P5: saved products. Ids only; the web app loads the products.
describe('Wishlist (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let n = 0;
  const http = () => request(app.getHttpServer());

  const login = async () => {
    const email = `wish${Date.now()}-${n++}@shopflow.dev`;
    await http()
      .post('/v1/auth/signup')
      .send({ email, password: 'secret123', name: 'Asha' })
      .expect(201);
    const res = await http()
      .post('/v1/auth/login')
      .send({ email, password: 'secret123' })
      .expect(200);
    return `Bearer ${res.body.accessToken as string}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UserModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, userAppOptions);
    await app.init();
    ds = app.get(DataSource);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('save, list newest first, save again (no-op), remove', async () => {
    const auth = await login();
    const list = async () => {
      const res = await http()
        .get('/v1/users/me/wishlist')
        .set('Authorization', auth)
        .expect(200);
      return (res.body as { items: { productId: string }[] }).items.map(
        (i) => i.productId,
      );
    };

    expect(await list()).toEqual([]);
    await http()
      .put(`/v1/users/me/wishlist/${P1}`)
      .set('Authorization', auth)
      .expect(204);
    await new Promise((r) => setTimeout(r, 10)); // distinct created_at
    await http()
      .put(`/v1/users/me/wishlist/${P2}`)
      .set('Authorization', auth)
      .expect(204);
    await http()
      .put(`/v1/users/me/wishlist/${P1}`)
      .set('Authorization', auth)
      .expect(204);
    expect(await list()).toEqual([P2, P1]);

    await http()
      .delete(`/v1/users/me/wishlist/${P2}`)
      .set('Authorization', auth)
      .expect(204);
    await http()
      .delete(`/v1/users/me/wishlist/${P2}`)
      .set('Authorization', auth)
      .expect(204);
    expect(await list()).toEqual([P1]);
  });

  it('only your own list; a bad id is refused; at most 100', async () => {
    const a = await login();
    const b = await login();
    await http()
      .put(`/v1/users/me/wishlist/${P1}`)
      .set('Authorization', a)
      .expect(204);
    const other = await http()
      .get('/v1/users/me/wishlist')
      .set('Authorization', b)
      .expect(200);
    expect(other.body.items).toEqual([]);

    await http()
      .put('/v1/users/me/wishlist/not-an-id')
      .set('Authorization', a)
      .expect(400);
    await http().get('/v1/users/me/wishlist').expect(401);

    // Fill up to the limit directly, then one more through the API.
    const userId = (
      await http().get('/v1/users/me').set('Authorization', a).expect(200)
    ).body.user.id as string;
    await ds.query(
      `INSERT INTO wishlist_items (user_id, product_id)
       SELECT $1, lpad(to_hex(g), 24, '0') FROM generate_series(1000, 1098) g`,
      [userId],
    );
    const full = await http()
      .put(`/v1/users/me/wishlist/${P2}`)
      .set('Authorization', a)
      .expect(409);
    expect(full.body.code).toBe('WISHLIST_FULL');
    // Saving one that's already there is still fine when full.
    await http()
      .put(`/v1/users/me/wishlist/${P1}`)
      .set('Authorization', a)
      .expect(204);
  });
});
