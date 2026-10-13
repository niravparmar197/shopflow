import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '@app/common';
import { userAppOptions } from '../src/app.setup';
import { UserModule } from '../src/user.module';

// Real user service + real PostgreSQL + real HTTP calls. The database and
// env come from e2e-setup.ts, which runs before this file is loaded.
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

  const user = {
    email: 'test@shopflow.dev',
    password: 'secret123',
    name: 'Test',
  };

  const http = () => request(app.getHttpServer());

  // The "rt=..." part of the refresh cookie a response sets.
  const refreshCookie = (res: request.Response): string => {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const rt = cookies.find((c) => c.startsWith('rt='));
    if (!rt) throw new Error('response did not set the rt cookie');
    return rt.split(';')[0];
  };

  // Login takes only email + password; any other field is rejected.
  const credentials = { email: user.email, password: user.password };
  const login = () =>
    http().post('/v1/auth/login').send(credentials).expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UserModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, userAppOptions); // same setup as main.ts
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('signup', () => {
    it('signs up and never returns the password hash', async () => {
      const res = await http()
        .post('/v1/auth/signup')
        .send({ ...user, email: '  Test@ShopFlow.dev ' })
        .expect(201);
      expect(res.body.user.email).toBe(user.email); // trimmed + lowercased
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('rejects a duplicate email with 409', async () => {
      const res = await http().post('/v1/auth/signup').send(user).expect(409);
      expect(res.body).toMatchObject({
        code: 'CONFLICT',
        message: 'Email is already registered',
      });
      expect(res.body.correlationId).toEqual(expect.any(String));
    });

    it('lets only one of two simultaneous signups with one email win', async () => {
      const body = {
        email: 'race@shopflow.dev',
        password: 'secret123',
        name: 'Race',
      };
      const results = await Promise.all([
        http().post('/v1/auth/signup').send(body),
        http().post('/v1/auth/signup').send(body),
      ]);
      // The unique index decides, not an "exists?" check.
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('rejects bad input and unknown fields (no role injection)', async () => {
      const res = await http()
        .post('/v1/auth/signup')
        .send({ email: 'bad', password: '123', name: 'N', role: 'admin' })
        .expect(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.details).toContain('property role should not exist');
    });
  });

  describe('login', () => {
    it('gives the same error for a wrong password and an unknown email', async () => {
      const wrongPassword = await http()
        .post('/v1/auth/login')
        .send({ email: user.email, password: 'wrong1234' })
        .expect(401);
      const unknownEmail = await http()
        .post('/v1/auth/login')
        .send({ email: 'nobody@shopflow.dev', password: 'wrong1234' })
        .expect(401);
      expect(wrongPassword.body.message).toBe('Invalid email or password');
      expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
    });

    it('sets a safe refresh cookie, and /users/me needs a valid token', async () => {
      const res = await login();
      expect(res.body.accessToken).toEqual(expect.any(String));

      const cookie = ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .join(';');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/v1/auth');

      const me = await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body.user.email).toBe(user.email);

      await http().get('/v1/users/me').expect(401);
      await http()
        .get('/v1/users/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('refresh', () => {
    it('rotates the token, and reusing an old one revokes the family', async () => {
      const first = refreshCookie(await login());

      const rotated = await http()
        .post('/v1/auth/refresh')
        .set('Cookie', first)
        .expect(200);
      expect(rotated.body.accessToken).toEqual(expect.any(String));
      const second = refreshCookie(rotated);
      expect(second).not.toBe(first);

      const reuse = await http()
        .post('/v1/auth/refresh')
        .set('Cookie', first)
        .expect(401);
      expect(reuse.body.message).toBe('Refresh token reuse detected');
      // The newer token was in the same family, so it is dead too.
      await http().post('/v1/auth/refresh').set('Cookie', second).expect(401);
    });

    it('lets only one of two simultaneous refreshes with one token succeed', async () => {
      const cookie = refreshCookie(await login());
      const results = await Promise.all([
        http().post('/v1/auth/refresh').set('Cookie', cookie),
        http().post('/v1/auth/refresh').set('Cookie', cookie),
      ]);
      // The row lock serializes them; the second sees a spent token.
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('rejects a request without a refresh cookie', async () => {
      const res = await http().post('/v1/auth/refresh').expect(401);
      expect(res.body.message).toBe('Missing refresh token');
    });
  });

  describe('logout', () => {
    it('revokes the refresh token and clears the cookie', async () => {
      const cookie = refreshCookie(await login());
      const res = await http()
        .post('/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      expect(refreshCookie(res)).toBe('rt=');
      await http().post('/v1/auth/refresh').set('Cookie', cookie).expect(401);
    });
  });
});
