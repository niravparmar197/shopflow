import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService, migrateAndExit } from '@app/common';
import { InventoryModule } from './inventory.module';
import { INVENTORY_ENTITIES } from './database/entities';
import { MIGRATIONS } from './database/migrations';

// `node main.js migrate` applies pending migrations and exits (run once per
// deploy, before rolling out the new version); otherwise start the service.
if (process.argv[2] === 'migrate') {
  migrateAndExit('inventory', {
    migrations: MIGRATIONS,
    entities: INVENTORY_ENTITIES,
  });
} else {
  void bootstrapService(InventoryModule, { globalPrefix: 'v1' });
}
