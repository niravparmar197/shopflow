import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { configureApp } from '@app/common';
import { UserEvents } from '@app/events';
import { userAppOptions } from '../src/app.setup';
import { AccountHousekeepingJob } from '../src/jobs/account-housekeeping.job';
import { UserModule } from '../src/user.module';

// Phase 2 P3: verify email, forgot / reset password, change password,
// profile. The emails themselves are sent by the notification service; here
// we check the events the user service leaves in its outbox.
describe('Account (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const http = () => request(app.getHttpServer());
  let n = 0;
  const newEmail = () => `acct${Date.now()}-${n++}@shopflow.dev`;
  const password = 'secret123';

  interface Ev {
    userId: string;
    email: string;
    token?: string;
    via?: string;
  }

  /** The events of one type for one email, oldest first. */
  const events = async (type: string, email: string): Promise<Ev[]> => {
    const rows = await ds.query<{ payload: { data: Ev } }[]>(
      `SELECT payload FROM outbox
        WHERE event_type = $1 AND payload->'data'->>'email' = $2
        ORDER BY created_at`,
      [type, email],
    );
    return rows.map((r) => r.payload.data);
  };
  const lastToken = async (type: string, email: string) =>
    (await events(type, email)).at(-1)!.token!;

  const cookieOf = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('rt='))!
      .split(';')[0];

  const signup = async (email = newEmail()) => {
    await http()
      .post('/v1/auth/signup')
      .send({ email, password, name: 'Asha' })
      .expect(201);
    return email;
  };
  const login = async (email: string, pw = password) => {
    const res = await http()
      .post('/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    return { token: res.body.accessToken as string, cookie: cookieOf(res) };
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

  describe('verify email', () => {
    it('signup sends a verify link; the link verifies once', async () => {
      const email = await signup();
      const { token } = await login(email);
      const me = await http()
        .get('/v1/users/me')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(me.body.user).toMatchObject({
        emailVerifiedAt: null,
        phone: null,
      });

      const [ev] = await events(UserEvents.EMAIL_VERIFICATION_REQUESTED, email);
      expect(ev.userId).toBe(me.body.user.id);
      expect(ev.token).toMatch(/^[\w-]{43}$/);
      // Only the hash is stored.
      const stored = await ds.query<{ token_hash: string }[]>(
        'SELECT token_hash FROM account_tokens WHERE user_id = $1',
        [ev.userId],
      );
      expect(stored[0].token_hash).not.toContain(ev.token);

      const res = await http()
        .post('/v1/auth/verify-email')
        .send({ token: ev.token })
        .expect(200);
      expect(res.body.user.emailVerifiedAt).toEqual(expect.any(String));
      expect(res.body.user.passwordHash).toBeUndefined();

      const again = await http()
        .post('/v1/auth/verify-email')
        .send({ token: ev.token })
        .expect(400);
      expect(again.body.code).toBe('INVALID_TOKEN');
    });

    it('resend: once a minute, the old link stops working, 409 when verified', async () => {
      const email = await signup();
      const { token } = await login(email);
      const resend = () =>
        http()
          .post('/v1/users/me/verify-email')
          .auth(token, { type: 'bearer' });

      expect((await resend().expect(429)).body.code).toBe('RESEND_TOO_SOON');

      // A minute later (moved back in time instead of waiting).
      const first = await lastToken(
        UserEvents.EMAIL_VERIFICATION_REQUESTED,
        email,
      );
      await ds.query(
        `UPDATE account_tokens SET created_at = now() - interval '2 minutes'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
      );
      await resend().expect(202);
      const second = await lastToken(
        UserEvents.EMAIL_VERIFICATION_REQUESTED,
        email,
      );
      expect(second).not.toBe(first);

      await http()
        .post('/v1/auth/verify-email')
        .send({ token: first })
        .expect(400);
      await http()
        .post('/v1/auth/verify-email')
        .send({ token: second })
        .expect(200);
      expect((await resend().expect(409)).body.code).toBe('ALREADY_VERIFIED');
    });
  });

  describe('forgot / reset password', () => {
    const forgot = (email: string) =>
      http().post('/v1/auth/forgot-password').send({ email }).expect(202);
    const resetType = UserEvents.PASSWORD_RESET_REQUESTED;

    it('answers the same for unknown emails and sends nothing', async () => {
      const email = newEmail();
      const res = await forgot(email);
      expect(res.body).toEqual({});
      expect(await events(resetType, email)).toHaveLength(0);
    });

    it('resets with the link: old password and all sessions stop working', async () => {
      const email = await signup();
      const { cookie } = await login(email);
      await forgot(` ${email.toUpperCase()} `); // normalised like login
      const token = await lastToken(resetType, email);

      await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: 'short' })
        .expect(400);
      await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: 'newpass456' })
        .expect(204);

      await http().post('/v1/auth/login').send({ email, password }).expect(401);
      const fresh = await login(email, 'newpass456');
      await http().post('/v1/auth/refresh').set('Cookie', cookie).expect(401);

      // Used once only.
      const reuse = await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: 'other789x' })
        .expect(400);
      expect(reuse.body.code).toBe('INVALID_TOKEN');

      // The link proved the inbox, so the email counts as verified too.
      const me = await http()
        .get('/v1/users/me')
        .auth(fresh.token, { type: 'bearer' })
        .expect(200);
      expect(me.body.user.emailVerifiedAt).toEqual(expect.any(String));

      const [changed] = await events(UserEvents.PASSWORD_CHANGED, email);
      expect(changed.via).toBe('RESET');
    });

    it('an expired link says so, and a new link replaces the old one', async () => {
      const email = await signup();
      await forgot(email);
      const old = await lastToken(resetType, email);
      await forgot(email);
      const current = await lastToken(resetType, email);

      const replaced = await http()
        .post('/v1/auth/reset-password')
        .send({ token: old, password: 'newpass456' })
        .expect(400);
      expect(replaced.body.code).toBe('INVALID_TOKEN');

      await ds.query(
        `UPDATE account_tokens SET expires_at = now() - interval '1 second'
          WHERE used_at IS NULL AND purpose = 'PASSWORD_RESET'
            AND user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
      );
      const expired = await http()
        .post('/v1/auth/reset-password')
        .send({ token: current, password: 'newpass456' })
        .expect(400);
      expect(expired.body.code).toBe('TOKEN_EXPIRED');
    });

    it('sends at most 3 reset emails an hour per account', async () => {
      const email = await signup();
      for (let i = 0; i < 5; i++) await forgot(email);
      expect(await events(resetType, email)).toHaveLength(3);
    });

    it('a verify token is not a reset token', async () => {
      const email = await signup();
      const verify = await lastToken(
        UserEvents.EMAIL_VERIFICATION_REQUESTED,
        email,
      );
      const res = await http()
        .post('/v1/auth/reset-password')
        .send({ token: verify, password: 'newpass456' })
        .expect(400);
      expect(res.body.code).toBe('INVALID_TOKEN');
    });
  });

  describe('change password', () => {
    it('checks the current password and keeps only this session', async () => {
      const email = await signup();
      const here = await login(email);
      const elsewhere = await login(email);
      const change = (body: object) =>
        http()
          .post('/v1/auth/change-password')
          .auth(here.token, { type: 'bearer' })
          .set('Cookie', here.cookie)
          .send(body);

      await http()
        .post('/v1/auth/change-password')
        .send({ currentPassword: password, newPassword: 'newpass456' })
        .expect(401);
      const wrong = await change({
        currentPassword: 'nope12345',
        newPassword: 'newpass456',
      }).expect(400);
      expect(wrong.body.code).toBe('WRONG_PASSWORD');
      const same = await change({
        currentPassword: password,
        newPassword: password,
      }).expect(400);
      expect(same.body.code).toBe('SAME_PASSWORD');

      await change({
        currentPassword: password,
        newPassword: 'newpass456',
      }).expect(204);

      await http()
        .post('/v1/auth/refresh')
        .set('Cookie', here.cookie)
        .expect(200);
      await http()
        .post('/v1/auth/refresh')
        .set('Cookie', elsewhere.cookie)
        .expect(401);
      await login(email, 'newpass456');

      const [ev] = await events(UserEvents.PASSWORD_CHANGED, email);
      expect(ev.via).toBe('CHANGE');
    });
  });

  describe('profile', () => {
    it('edits name and phone; email cannot be changed here', async () => {
      const email = await signup();
      const { token } = await login(email);
      const patch = (body: object) =>
        http().patch('/v1/users/me').auth(token, { type: 'bearer' }).send(body);

      const res = await patch({
        fullName: '  Asha  Patel ',
        phone: '+91 98765-43210',
      }).expect(200);
      expect(res.body.user).toMatchObject({
        fullName: 'Asha  Patel',
        phone: '9876543210',
        email,
      });

      await patch({ phone: '12345' }).expect(400);
      await patch({ fullName: 'A' }).expect(400);
      await patch({ email: 'other@shopflow.dev' }).expect(400);

      const cleared = await patch({ phone: '' }).expect(200);
      expect(cleared.body.user).toMatchObject({
        phone: null,
        fullName: 'Asha  Patel',
      });
    });
  });

  describe('housekeeping', () => {
    it('drops sent account events after a day and old tokens after a week', async () => {
      const email = await signup();
      const userId = (
        await events(UserEvents.EMAIL_VERIFICATION_REQUESTED, email)
      )[0].userId;
      // As if the relay sent it 2 days ago, and the link died 8 days ago.
      await ds.query(
        `UPDATE outbox SET published_at = now() - interval '2 days'
          WHERE payload->'data'->>'email' = $1`,
        [email],
      );
      await ds.query(
        `UPDATE account_tokens SET expires_at = now() - interval '8 days'
          WHERE user_id = $1`,
        [userId],
      );
      const unsent = await signup(); // not published yet: must stay

      const result = await app.get(AccountHousekeepingJob).tick();
      expect(result).toBe('ran');

      expect(
        await events(UserEvents.EMAIL_VERIFICATION_REQUESTED, email),
      ).toHaveLength(0);
      const tokens = await ds.query<unknown[]>(
        'SELECT 1 FROM account_tokens WHERE user_id = $1',
        [userId],
      );
      expect(tokens).toHaveLength(0);
      expect(
        await events(UserEvents.EMAIL_VERIFICATION_REQUESTED, unsent),
      ).toHaveLength(1);
    });
  });
});
