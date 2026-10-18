import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '@app/common';
import { userAppOptions } from '../src/app.setup';
import { UserModule } from '../src/user.module';

interface ApiAddress {
  id: string;
  fullName: string;
  phone: string;
  pincode: string;
  isDefault: boolean;
}

// The address book: real user service + real PostgreSQL.
describe('Addresses (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  const home = {
    fullName: 'Asha Patel',
    phone: '+91 98765 43210',
    line1: '12, Shanti Nagar, SG Highway',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380015',
  };

  let seq = 0;
  async function newUser() {
    const email = `addr${++seq}-${Date.now()}@shopflow.dev`;
    await http()
      .post('/v1/auth/signup')
      .send({ email, password: 'secret123', name: 'Addr' })
      .expect(201);
    const res = await http()
      .post('/v1/auth/login')
      .send({ email, password: 'secret123' })
      .expect(200);
    return `Bearer ${(res.body as { accessToken: string }).accessToken}`;
  }
  const list = async (auth: string) =>
    (
      await http()
        .get('/v1/users/me/addresses')
        .set('Authorization', auth)
        .expect(200)
    ).body.items as ApiAddress[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UserModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, userAppOptions);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('needs a login', async () => {
    await http().get('/v1/users/me/addresses').expect(401);
  });

  it('the first address is the default; phone is normalised', async () => {
    const auth = await newUser();
    const res = await http()
      .post('/v1/users/me/addresses')
      .set('Authorization', auth)
      .send(home)
      .expect(201);
    expect(res.body).toMatchObject({
      fullName: 'Asha Patel',
      phone: '9876543210',
      pincode: '380015',
      line2: null,
      isDefault: true,
    });
  });

  it('a new default takes over; deleting the default promotes the newest', async () => {
    const auth = await newUser();
    const add = (body: object) =>
      http()
        .post('/v1/users/me/addresses')
        .set('Authorization', auth)
        .send({ ...home, ...body })
        .expect(201)
        .then((r) => r.body as ApiAddress);

    const a = await add({ fullName: 'Home' });
    const b = await add({ fullName: 'Office' });
    expect(b.isDefault).toBe(false);
    const c = await add({ fullName: 'Parents', isDefault: true });

    let items = await list(auth);
    expect(items.map((x) => [x.fullName, x.isDefault])).toEqual([
      ['Parents', true],
      ['Office', false],
      ['Home', false],
    ]);

    await http()
      .patch(`/v1/users/me/addresses/${a.id}`)
      .set('Authorization', auth)
      .send({ isDefault: true, city: 'Gandhinagar' })
      .expect(200);
    items = await list(auth);
    expect(items[0]).toMatchObject({ id: a.id, isDefault: true });
    expect(items.filter((x) => x.isDefault)).toHaveLength(1);

    await http()
      .delete(`/v1/users/me/addresses/${a.id}`)
      .set('Authorization', auth)
      .expect(204);
    items = await list(auth);
    expect(items.find((x) => x.isDefault)?.id).toBe(c.id); // newest left
  });

  it('validates phone and PIN code', async () => {
    const auth = await newUser();
    const res = await http()
      .post('/v1/users/me/addresses')
      .set('Authorization', auth)
      .send({ ...home, phone: '12345', pincode: '0800' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('pincode must be 6 digits');
  });

  it("another user's address is a 404", async () => {
    const owner = await newUser();
    const other = await newUser();
    const a = (
      await http()
        .post('/v1/users/me/addresses')
        .set('Authorization', owner)
        .send(home)
        .expect(201)
    ).body as ApiAddress;
    await http()
      .patch(`/v1/users/me/addresses/${a.id}`)
      .set('Authorization', other)
      .send({ city: 'Pune' })
      .expect(404);
    await http()
      .delete(`/v1/users/me/addresses/${a.id}`)
      .set('Authorization', other)
      .expect(404);
  });

  it('at most 10 addresses', async () => {
    const auth = await newUser();
    for (let i = 0; i < 10; i++) {
      await http()
        .post('/v1/users/me/addresses')
        .set('Authorization', auth)
        .send(home)
        .expect(201);
    }
    const res = await http()
      .post('/v1/users/me/addresses')
      .set('Authorization', auth)
      .send(home)
      .expect(409);
    expect(res.body).toMatchObject({ code: 'ADDRESS_LIMIT' });
  });
});
