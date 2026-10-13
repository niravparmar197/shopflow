import cookieParser from 'cookie-parser';
import { bootstrapService } from '@app/common';
import { UserModule } from './user.module';

void bootstrapService(UserModule, {
  globalPrefix: 'v1',
  configure: (app) => app.use(cookieParser()), // reads the refresh token cookie
});
