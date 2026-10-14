import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService, migrateAndExit } from '@app/common';
import { userAppOptions } from './app.setup';
import { UserModule } from './user.module';
import { USER_ENTITIES } from './entities';
import { MIGRATIONS } from './database/migrations';

// `node main.js migrate` applies pending migrations and exits (run once per
// deploy, before rolling out the new version); otherwise start the service.
if (process.argv[2] === 'migrate') {
  migrateAndExit('user', { migrations: MIGRATIONS, entities: USER_ENTITIES });
} else {
  void bootstrapService(UserModule, userAppOptions);
}
