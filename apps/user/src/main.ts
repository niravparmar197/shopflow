import { bootstrapService } from '@app/common';
import { UserModule } from './user.module';

void bootstrapService(UserModule, { globalPrefix: 'v1' });
