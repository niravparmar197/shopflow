import { bootstrapService } from '@app/common';
import { notificationAppOptions } from './app.setup';
import { NotificationModule } from './notification.module';

void bootstrapService(NotificationModule, notificationAppOptions);
