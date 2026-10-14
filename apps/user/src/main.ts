import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService } from '@app/common';
import { userAppOptions } from './app.setup';
import { UserModule } from './user.module';

void bootstrapService(UserModule, userAppOptions);
