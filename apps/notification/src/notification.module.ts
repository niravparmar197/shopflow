import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'notification' })],
  controllers: [NotificationController],
  providers: [NotificationService],
})
export class NotificationModule {}
