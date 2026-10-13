import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { InventoryModule } from '../src/inventory.module';

// The containers and env come from e2e-setup.ts.

/** The real inventory service: consumers and outbox relay running. */
export async function startInventoryApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [InventoryModule],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    bufferLogs: true,
  });
  // Same logger as main.ts; silent under NODE_ENV=test, so the expected
  // failures (poison, retry) don't flood the output.
  app.useLogger(app.get(Logger));
  await app.init(); // starts the consumers and the relay

  const ds = app.get(DataSource);
  return {
    app,
    ds,
    brokers: process.env.KAFKA_BROKERS!.split(','),
    reset: () =>
      ds.query('TRUNCATE stock, reservations, outbox, processed_events'),
  };
}
