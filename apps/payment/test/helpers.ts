import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { configureApp, JWT_AUDIENCE, JWT_ISSUER } from '@app/common';
import { paymentAppOptions } from '../src/app.setup';
import { PaymentModule } from '../src/payment.module';

// The containers and env come from e2e-setup.ts.

/** The real payment service: consumers and outbox relay running, sweeper off. */
export async function startPaymentApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [PaymentModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    bufferLogs: true,
    // As in main.ts. Without it req.rawBody is empty and every webhook
    // fails with NO_RAW_BODY.
    rawBody: paymentAppOptions.rawBody,
  });
  app.useLogger(app.get(Logger)); // silent under NODE_ENV=test
  configureApp(app, paymentAppOptions); // same prefix, pipes, filters as main.ts
  // One server on a free port, instead of supertest starting one per request.
  await app.listen(0, '127.0.0.1');

  const signer = new JwtService({
    privateKey: readFileSync(process.env.E2E_JWT_PRIVATE_KEY_PATH!),
    signOptions: {
      algorithm: 'RS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '5m',
    },
  });

  const ds = app.get(DataSource);
  return {
    app,
    ds,
    brokers: process.env.KAFKA_BROKERS!.split(','),
    webhookSecret: process.env.FAKE_WEBHOOK_SECRET!,
    http: () => request(app.getHttpServer()),
    bearer: (sub: string) =>
      `Bearer ${signer.sign({ sub, email: `${sub}@test.dev`, role: 'customer' })}`,
    reset: () =>
      ds.query('TRUNCATE payments, webhook_events, outbox, processed_events'),
  };
}
