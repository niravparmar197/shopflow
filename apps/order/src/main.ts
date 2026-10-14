import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService, migrateAndExit } from '@app/common';
import { orderAppOptions } from './app.setup';
import { OrderModule } from './order.module';
import { ORDER_ENTITIES } from './database/entities';
import { MIGRATIONS } from './database/migrations';

// `node main.js migrate` applies pending migrations and exits (run once per
// deploy, before rolling out the new version); otherwise start the service.
if (process.argv[2] === 'migrate') {
  migrateAndExit('order', { migrations: MIGRATIONS, entities: ORDER_ENTITIES });
} else {
  void bootstrapService(OrderModule, orderAppOptions);
}
