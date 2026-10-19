import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import type { NextFunction, Request, Response } from 'express';
import { AccountEmailPlanner } from './commands/account-email-planner';
import { CommandDispatcher } from './commands/command-dispatcher';
import { NOTIFICATIONS_QUEUE } from './commands/notification-command';
import { NotificationPlanner } from './commands/notification-planner';
import { EMAIL_SENDER, SmtpEmailSender } from './email/email-sender';
import { SesEmailSender } from './email/ses-email-sender';
import { COMMAND_HANDLERS } from './handlers/command-handler';
import { SendEmailHandler } from './handlers/send-email.handler';
import { LogsController } from './logs/logs.controller';
import {
  NotificationLog,
  NotificationLogSchema,
} from './logs/notification-log.schema';
import { NotificationsConsumer } from './notifications.consumer';
import { OrderView, OrderViewSchema } from './projection/order-view.schema';
import { ProjectionService } from './projection/projection.service';
import { NotificationsProcessor } from './worker/notifications.processor';

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Bull Board (queue UI) is DEV ONLY: it can retry and delete jobs. In
 * production it would need admin auth or a VPN. Left out when NODE_ENV is
 * set in the real environment; the middleware also checks per request,
 * because a NODE_ENV that only lives in .env isn't loaded yet here.
 */
const bullBoard = isProduction()
  ? []
  : [
      BullBoardModule.forRoot({
        route: '/queues',
        adapter: ExpressAdapter,
        middleware: (_req: Request, res: Response, next: NextFunction) =>
          isProduction() ? res.status(404).end() : next(),
      }),
      BullBoardModule.forFeature({
        name: NOTIFICATIONS_QUEUE,
        adapter: BullMQAdapter,
      }),
    ];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrderView.name, schema: OrderViewSchema },
      { name: NotificationLog.name, schema: NotificationLogSchema },
    ]),
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
    ...bullBoard,
  ],
  controllers: [LogsController],
  providers: [
    // Kafka → commands on the queue
    ProjectionService,
    NotificationPlanner,
    AccountEmailPlanner,
    CommandDispatcher,
    NotificationsConsumer,
    // Queue → execute the commands
    NotificationsProcessor,
    SendEmailHandler,
    // EMAIL_PROVIDER picks the sender; the rest of the service doesn't care.
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('EMAIL_PROVIDER', { infer: true }) === 'ses'
          ? new SesEmailSender(config)
          : new SmtpEmailSender(config),
    },
    {
      provide: COMMAND_HANDLERS,
      inject: [SendEmailHandler],
      useFactory: (email: SendEmailHandler) => [email],
    },
  ],
})
export class NotificationsModule {}
