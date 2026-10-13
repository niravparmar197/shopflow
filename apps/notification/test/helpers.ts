import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { readFileSync } from 'node:fs';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp, JWT_AUDIENCE, JWT_ISSUER } from '@app/common';
import { notificationAppOptions } from '../src/app.setup';
import { NOTIFICATIONS_QUEUE } from '../src/commands/notification-command';
import { EMAIL_SENDER } from '../src/email/email-sender';
import { NotificationLog } from '../src/logs/notification-log.schema';
import { NotificationModule } from '../src/notification.module';
import { OrderView } from '../src/projection/order-view.schema';
import { FakeEmailSender } from './fake-email-sender';

// The containers and env come from e2e-setup.ts.

/** The real notification service; only the SMTP sender is faked. */
export async function startNotificationApp() {
  const fakeEmail = new FakeEmailSender();
  const moduleRef = await Test.createTestingModule({
    imports: [NotificationModule],
  })
    .overrideProvider(EMAIL_SENDER)
    .useValue(fakeEmail)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger)); // silent under NODE_ENV=test
  configureApp(app, notificationAppOptions); // same setup as main.ts
  await app.listen(0, '127.0.0.1'); // starts the consumer and the worker

  const queue = app.get<Queue>(getQueueToken(NOTIFICATIONS_QUEUE));
  const logs = app.get<Model<NotificationLog>>(
    getModelToken(NotificationLog.name),
  );
  const views = app.get<Model<OrderView>>(getModelToken(OrderView.name));

  const signer = new JwtService({
    privateKey: readFileSync(process.env.E2E_JWT_PRIVATE_KEY_PATH!),
    signOptions: {
      algorithm: 'RS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '5m',
    },
  });

  return {
    app,
    brokers: process.env.KAFKA_BROKERS!.split(','),
    fakeEmail,
    queue,
    logs,
    views,
    http: () => request(app.getHttpServer()),
    bearer: (sub: string, role = 'customer') =>
      `Bearer ${signer.sign({ sub, email: `${sub}@test.dev`, role })}`,
    reset: async () => {
      fakeEmail.reset();
      await queue.obliterate({ force: true });
      await Promise.all([logs.deleteMany({}), views.deleteMany({})]);
    },
  };
}
