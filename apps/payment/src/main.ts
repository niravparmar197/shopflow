import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService, migrateAndExit } from '@app/common';
import { paymentAppOptions } from './app.setup';
import { PaymentModule } from './payment.module';
import { PAYMENT_ENTITIES } from './database/entities';
import { MIGRATIONS } from './database/migrations';

// `node main.js migrate` applies pending migrations and exits (run once per
// deploy, before rolling out the new version); otherwise start the service.
if (process.argv[2] === 'migrate') {
  migrateAndExit('payment', {
    migrations: MIGRATIONS,
    entities: PAYMENT_ENTITIES,
  });
} else {
  void bootstrapService(PaymentModule, paymentAppOptions);
}
