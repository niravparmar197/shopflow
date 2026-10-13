import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommandDispatcher } from './commands/command-dispatcher';
import { NOTIFICATIONS_QUEUE } from './commands/notification-command';
import { NotificationPlanner } from './commands/notification-planner';
import {
  NotificationLog,
  NotificationLogSchema,
} from './logs/notification-log.schema';
import { NotificationsConsumer } from './notifications.consumer';
import { OrderView, OrderViewSchema } from './projection/order-view.schema';
import { ProjectionService } from './projection/projection.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrderView.name, schema: OrderViewSchema },
      { name: NotificationLog.name, schema: NotificationLogSchema },
    ]),
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
  ],
  providers: [
    ProjectionService,
    NotificationPlanner,
    CommandDispatcher,
    NotificationsConsumer,
  ],
})
export class NotificationsModule {}
